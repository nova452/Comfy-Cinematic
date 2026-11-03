import { runModel } from "../../../lib/router";
import { dataUrl } from "../../../lib/media-data";
import { NextResponse } from "next/server";
import {
  acceptsVideo,
  buildBrainRequest,
  DEFAULT_BRAIN,
  parsePromptSpec,
  parseVideoPrompt,
  readBrainText,
  referencePrompt,
  resolveBrain,
  VIDEO_SYSTEM_PROMPT,
} from "../../../lib/brain";
import { MAX_PROMPT } from "../../../lib/harness";
import { activeEndpoint, endpointKey, envOpenRouterKey, envRouterKey, readAccount, routerKey } from "../../../lib/account";
import { buildReferencePrompt, buildReferenceRequest, parseReferenceRewrite, buildContinuationPrompt } from "../../../lib/reference";
import { runLocalVideo } from "../../../lib/local-video";
import {
  DEFAULT_VIDEO_MODEL,
  OPENJUTSU_DEFAULTS,
  OPENJUTSU_MODEL_ID,
  buildVideoRequest,
  findVideoModel,
  isRef5Render,
  maxCharacterImages,
  findVideoRatio,
  findVideoResolution,
  videoResultError,
  videoResultUrl,
  type VideoMode,
} from "../../../lib/video";
import { readLocalConfig, readOpenjutsuConfig } from "../../../lib/local-config";
import { isBase64Value, isMediaUri } from "../../../lib/media-uri";
import { CANCELLED_MESSAGE, cancelSignal, finishProgress, isRenderId, reportProgress } from "../../../lib/render-progress";

export const runtime = "nodejs";
// Openjutsu Prime may run 35 minutes (`OPENJUTSU_TIMEOUT_MS`); the rest stop
// at 14. Five more cover its uploads and download.
export const maxDuration = 2400;

const DEFAULT_MODEL = process.env.HARNESS_MODEL?.trim() || DEFAULT_BRAIN;

const MAX_REFERENCE_CHARS = 3_000_000;

type VideoRequest = {
  prompt?: unknown;
  mode?: unknown;
  model?: unknown;
  ratio?: unknown;
  resolution?: unknown;
  duration?: unknown;
  characters?: unknown;
  background?: unknown;
  firstFrame?: unknown;
  lastFrame?: unknown;
  audio?: unknown;
  video?: unknown;
  /** A Video Reference render that extends the attached clip. */
  continuation?: unknown;
  /** That clip's last frames, cut in the panel for Router. */
  continuationVideo?: unknown;
  enhance?: unknown;
  brain?: unknown;
  /** The canvas tile's id, under which `/api/video/progress` reports this render. */
  renderId?: unknown;
  /** Openjutsu with the prompt off: the graph plans the edit. */
  auto?: unknown;
  /** Openjutsu: where the trim window starts in the clip, in seconds. */
  start?: unknown;
};

function requestIdOf(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const requestId = Reflect.get(error, "requestId");
  return typeof requestId === "string" ? requestId : undefined;
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Copy a finished clip off the provider's link.
 *
 * Most of those links are signed and need nothing. Router also hands back
 * asset addresses that want the same key the render used, so a 401/403 on the
 * anonymous attempt is retried once with it rather than reported as a failed
 * render — the clip is already paid for at that point.
 */
async function downloadClip(url: string, apiKey: string | undefined) {
  const attempt = (init: RequestInit) =>
    fetch(url, { cache: "no-store", signal: AbortSignal.timeout(120_000), ...init });

  const anonymous = await attempt({});
  if (anonymous.ok || (anonymous.status !== 401 && anonymous.status !== 403) || !apiKey) return anonymous;
  return attempt({ headers: { authorization: `Bearer ${apiKey}` } });
}

function isBase64(value: string, max: number) {
  return isBase64Value(value, max);
}

export async function POST(request: Request) {
  // Filled once the body is read. The answer is also kept under that id, so a
  // page that reloaded while this ran can still collect the clip: the render
  // runs to the end whether or not anyone is left to read the response.
  const progress: { id?: string } = {};
  let response: Response;
  try {
    response = await render(request, progress);
  } catch (error) {
    // Anything that escapes the render's own handler is a bug, but a bare 500
    // leaves the panel with nothing to show. Report it as data instead.
    console.error("[video] unhandled failure", error);
    response = NextResponse.json(
      {
        error: error instanceof Error ? error.message : "The video route failed.",
        code: "video_crashed",
      },
      { status: 500 },
    );
  }
  if (progress.id) {
    const body: unknown = await response.clone().json().catch(() => undefined);
    finishProgress(progress.id, response.ok, body);
  }
  return response;
}

async function render(request: Request, progress: { id?: string }) {
  let body: VideoRequest;
  try {
    body = (await request.json()) as VideoRequest;
  } catch {
    return NextResponse.json({ error: "Send a JSON request." }, { status: 400 });
  }
  if (isRenderId(body.renderId)) {
    progress.id = body.renderId;
    reportProgress(progress.id, { stage: "starting" });
  }
  // The tile's ✕ (`/api/render/cancel`) fires this; every step below hears it.
  const signal = cancelSignal(progress.id);

  const sourcePrompt = typeof body.prompt === "string" ? body.prompt.replace(/\s+/g, " ").trim() : "";
  // A reference mode can run on the attachments alone, so only a one-character
  // prompt is refused here; the mode check below asks Free mode for words.
  if (sourcePrompt.length === 1) {
    return NextResponse.json({ error: "Describe the shot first." }, { status: 400 });
  }
  if (sourcePrompt.length > MAX_PROMPT) {
    return NextResponse.json({ error: `Keep the prompt under ${MAX_PROMPT} characters.` }, { status: 400 });
  }

  const model = findVideoModel(typeof body.model === "string" ? body.model : "") ?? DEFAULT_VIDEO_MODEL;
  const ratio = findVideoRatio(body.ratio, model.ratio, model.ratios).id;
  const resolution = findVideoResolution(body.resolution, model.resolution, model.resolutions);
  const mode = (typeof body.mode === "string" ? body.mode : "free") as VideoMode;
  if (!model.modes.includes(mode)) {
    return NextResponse.json({ error: `${model.label} does not support that mode.` }, { status: 400 });
  }
  if (mode === "free" && sourcePrompt.length < 2) {
    return NextResponse.json({ error: "Describe the shot first." }, { status: 400 });
  }

  const duration =
    typeof body.duration === "number" && Number.isFinite(body.duration)
      ? Math.round(body.duration)
      : model.duration;
  if (duration < model.minDuration || duration > model.maxDuration) {
    return NextResponse.json(
      { error: `${model.label} renders ${model.minDuration}–${model.maxDuration}s clips.` },
      { status: 400 },
    );
  }

  const background = typeof body.background === "string" ? body.background : "";
  if (background && !isBase64(background, MAX_REFERENCE_CHARS)) {
    return NextResponse.json({ error: "The background reference is not a valid image." }, { status: 400 });
  }

  // Openjutsu turns each of up to eight characters into a sheet and takes no
  // background; everything else keeps Router's three.
  const ref5 = isRef5Render(model, mode, body.continuation === true);
  const maxCharacters = maxCharacterImages(model, mode, body.continuation === true);
  // With the prompt off, the graph's own prompt model plans the edit.
  const auto = ref5 && body.auto === true;
  // Openjutsu takes the whole clip and cuts the trim window in its loader.
  const start =
    ref5 && typeof body.start === "number" && Number.isFinite(body.start) && body.start > 0
      ? Math.min(body.start, 6 * 60 * 60)
      : 0;
  if (ref5 && !auto && sourcePrompt.length < 2) {
    return NextResponse.json(
      { error: "Describe the edit, or turn the prompt off to let the model decide." },
      { status: 400 },
    );
  }
  const characterList = Array.isArray(body.characters) ? body.characters : [];
  const characters = characterList.filter((item): item is string => typeof item === "string" && item.length > 0);
  if (characters.length > maxCharacters) {
    return NextResponse.json({ error: `At most ${maxCharacters} character references.` }, { status: 400 });
  }
  for (const reference of characters) {
    if (!isBase64(reference, MAX_REFERENCE_CHARS)) {
      return NextResponse.json({ error: "A character reference is not a valid image." }, { status: 400 });
    }
  }
  // Openjutsu casts characters into a clip; with none it has nothing to do.
  if (ref5 && characters.length === 0) {
    return NextResponse.json({ error: "Openjutsu Prime needs at least one character to cast into the clip." }, { status: 400 });
  }

  const firstFrame = typeof body.firstFrame === "string" ? body.firstFrame : "";
  const lastFrame = typeof body.lastFrame === "string" ? body.lastFrame : "";
  for (const [label, frame] of [
    ["first", firstFrame],
    ["last", lastFrame],
  ] as const) {
    if (!frame) continue;
    if (mode !== "free") {
      return NextResponse.json({ error: "First and last frames only apply to Free mode." }, { status: 400 });
    }
    if (!isBase64(frame, MAX_REFERENCE_CHARS)) {
      return NextResponse.json({ error: `The ${label} frame is not a valid image.` }, { status: 400 });
    }
  }

  // Keyframe roles and reference_* roles cannot share a request, so keyframes win.
  const keyframes = Boolean(firstFrame || lastFrame);

  // The fal entries take a prompt and nothing else.
  if (model.references === false && (keyframes || characters.length > 0 || background)) {
    return NextResponse.json(
      { error: `${model.label} renders from a text prompt only. Remove the reference images.` },
      { status: 400 },
    );
  }

  const audio = typeof body.audio === "string" ? body.audio : "";
  if (mode === "audio" && !audio) {
    return NextResponse.json({ error: "Audio Reference mode needs an audio file." }, { status: 400 });
  }
  if (audio && !isMediaUri(audio, "audio")) {
    return NextResponse.json({ error: "That audio reference is not a usable data URI." }, { status: 400 });
  }

  const video = typeof body.video === "string" ? body.video : "";
  if (mode === "video" && !video) {
    return NextResponse.json({ error: "Video Reference mode needs a video file." }, { status: 400 });
  }
  if (video && !isMediaUri(video, "video")) {
    return NextResponse.json({ error: "That video reference is not a usable data URI." }, { status: 400 });
  }

  // Router takes a clip, never a time range, so the panel cuts the tail itself
  // and sends it beside the whole clip: one goes to the prompt model, the other
  // to the model that renders.
  const continuationVideo = typeof body.continuationVideo === "string" ? body.continuationVideo : "";
  if (continuationVideo && !isMediaUri(continuationVideo, "video")) {
    return NextResponse.json({ error: "The continuation frames are not a usable data URI." }, { status: 400 });
  }

  const account = await readAccount(request);
  const apiKey = await routerKey(request);
  const endpoint = activeEndpoint(account);
  const local = model.provider === "local";
  // Each local row keeps its own settings. A continuation renders the plain
  // stack instead of the ref5 graph, but it is still Openjutsu's render.
  const localConfig = local
    ? await (model.id === OPENJUTSU_MODEL_ID ? readOpenjutsuConfig(request) : readLocalConfig(request))
    : undefined;

  if (local) {
    if (!endpoint) {
      return NextResponse.json(
        {
          error: "Workflow renders need a Comfy deployment (Settings) or COMFY_BASE_URL pointing at your ComfyUI.",
          code: "missing_local_endpoint",
        },
        { status: 503 },
      );
    }
    // The OpenRouter API (Kimi, and Light's border check) calls out of ComfyUI;
    // without a key it answers with an error string and H3 would render from
    // nothing. The Comfy API (Gemini) needs no OpenRouter key.
    const promptApi = localConfig?.promptApi ?? OPENJUTSU_DEFAULTS.promptApi;
    if (ref5 && promptApi === "openrouter" && !(localConfig?.openRouterKey || envOpenRouterKey())) {
      return NextResponse.json(
        {
          error:
            "Openjutsu Prime needs an OpenRouter key for the OR API. Add it in the model's gear, or set OPENROUTER_API_KEY.",
          code: "missing_openrouter_key",
        },
        { status: 503 },
      );
    }
    // A first or last frame in Free mode is not refused: it selects the local
    // graph's image-to-video stack, the same one ComfyUI's own H3 template
    // ships, with the frame(s) as its keyframes.
  } else if (!apiKey) {
    return NextResponse.json(
      { error: "Sign in with your Comfy Router API key (top right) to render.", code: "missing_key" },
      { status: 503 },
    );
  }

  // A reference is not a suggestion: audio and video reference modes hand a
  // model a clip plus a sentence, so the shot it writes is what the render is
  // actually of. They always rewrite — with MiniMax H3 Local's gear model, or
  // the account's Gemini 3.8 Flash at medium thinking — and the panel hides
  // its Flavor button rather than pretending the choice is local.
  const reference = mode !== "free";
  // A continuation is the same clip read two ways: the prompt model watches all
  // of it, and only its tail is handed to H3 as a motion reference.
  const continuation = mode === "video" && body.continuation === true && Boolean(video);
  // MiniMax H3 Local's gear owns its reference rewrite model, since that is
  // where the rewrite runs; the account's setting stays the Router default.
  const localPrompt = local ? parsePromptSpec(localConfig?.promptModel ?? "") : undefined;
  const referenceSettings = reference
    ? localPrompt && acceptsVideo(localPrompt.brain)
      ? localPrompt
      : referencePrompt(account)
    : undefined;
  // The ref5 graph writes its own prompts from the clip and the character
  // sheets it draws, so the user's words go to it untouched.
  const enhance = !ref5 && (reference || body.enhance !== false);
  const brain = reference
    ? referenceSettings!.brain
    : resolveBrain(typeof body.brain === "string" ? body.brain : "", DEFAULT_MODEL);
  const thinking = referenceSettings?.thinking;

  // Prompt enhancement is optional for the other modes: the same picker governs video.
  let prompt = sourcePrompt;
  let enhanced = false;
  if (enhance && brain) {
    reportProgress(progress.id, { stage: "rewriting" });
    try {
      const request = reference
        ? buildReferenceRequest(
            brain,
            continuation
              ? buildContinuationPrompt(duration, sourcePrompt)
              : buildReferencePrompt(sourcePrompt, {
                  characters: characters.length,
                  background: Boolean(background),
                  video: Boolean(video),
                  audio: Boolean(audio),
                }),
            { images: [...characters, ...(background ? [background] : [])], video, audio },
            thinking,
          )
        : buildBrainRequest(brain, sourcePrompt, VIDEO_SYSTEM_PROMPT, thinking);
      const result = await runModel(apiKey, brain, request, {
        // Reading a clip takes longer than writing from a sentence.
        timeoutMs: reference ? 180_000 : 60_000,
        signal,
      });
      if (result.kind === "json") {
        const text = readBrainText(brain, result.data);
        const rewritten = text
          ? reference
            ? parseReferenceRewrite(text)
            : parseVideoPrompt(text)
          : undefined;
        if (rewritten) {
          prompt = rewritten;
          enhanced = true;
        }
      }
    } catch {
      // A failed rewrite is not a failed render: fall back to the typed prompt.
    }
  }

  // A cancel during the rewrite was swallowed as a failed rewrite; stop here.
  if (signal?.aborted) {
    return NextResponse.json({ error: CANCELLED_MESSAGE, code: "cancelled" }, { status: 409 });
  }

  const phrase = "";
  const finalPrompt = prompt;

  try {
    const usedCharacters = keyframes ? [] : characters;
    // The ref5 graph has no background slot: the clip is the scene.
    const usedBackground = keyframes || ref5 ? "" : background;

    const images = [
      ...usedCharacters.map((reference) => `data:image/jpeg;base64,${reference}`),
      ...(usedBackground ? [`data:image/jpeg;base64,${usedBackground}`] : []),
    ];

    if (local) {
      const rendered = await runLocalVideo(
        {
          prompt: finalPrompt,
          mode,
          ratio,
          resolution,
          duration,
          images,
          ...(ref5 ? { openjutsu: true } : {}),
          ...(auto ? { auto } : {}),
          ...(start ? { start } : {}),
          ...(keyframes
            ? {
                ...(firstFrame ? { firstFrame: `data:image/jpeg;base64,${firstFrame}` } : {}),
                ...(lastFrame ? { lastFrame: `data:image/jpeg;base64,${lastFrame}` } : {}),
              }
            : {}),
          ...(audio ? { audio } : {}),
          ...(video ? { video } : {}),
          ...(continuation ? { continuation } : {}),
        },
        // A hosted deployment refuses an anonymous /api/v2/jobs, so the
        // signed-in key goes with it; a local ComfyUI only takes its own.
        // The Gemini prompt node is a partner node, which reads the Comfy key
        // from extra_data, so the signed-in key rides along for it too.
        {
          signal,
          apiKey: endpointKey(account),
          baseUrl: endpoint,
          config: localConfig,
          ...(ref5 && (localConfig?.promptApi ?? OPENJUTSU_DEFAULTS.promptApi) !== "openrouter"
            ? { orgKey: account?.key?.trim() || envRouterKey() }
            : {}),
          onProgress: (update) => reportProgress(progress.id, update),
        },
      );
      const src = dataUrl(rendered.bytes, rendered.contentType);

      // The ref5 graph reports the prompt its own model wrote for H3.
      return NextResponse.json({
        kind: "video",
        src,
        prompt: rendered.prompt ?? finalPrompt,
        sourcePrompt,
        enhanced: enhanced || Boolean(rendered.prompt),
        keyframes,
        mode,
        media: "video",
        model: model.id,
        requestId: rendered.requestId,
        ...(rendered.timing ? { timing: rendered.timing } : {}),
        // The upscale failed after the finished clip was saved; this is that
        // clip, and the warning says so.
        ...(rendered.fallback ? { fallback: true, warning: rendered.warning } : {}),
      });
    }

    const payload = buildVideoRequest(
      {
        prompt: finalPrompt,
        mode,
        ratio,
        duration,
        resolution,
        // fal always expands the prompt; keep its pass light when ours already ran.
        expansion: enhanced ? "balanced" : "quality",
        references: {
          images,
          ...(audio ? { audio } : {}),
          // A continuation hands Router the tail rather than the whole clip;
          // without one, the rewritten prompt carries the continuity alone.
          ...(continuation ? (continuationVideo ? { video: continuationVideo } : {}) : video ? { video } : {}),
          ...(firstFrame ? { firstFrame: `data:image/jpeg;base64,${firstFrame}` } : {}),
          ...(lastFrame ? { lastFrame: `data:image/jpeg;base64,${lastFrame}` } : {}),
        },
      },
      model.api,
    );

    reportProgress(progress.id, { stage: "running" });
    // On a cancel the SDK makes a best-effort cancel of the Router request too.
    const result = await runModel(apiKey, model.id, payload, { timeoutMs: 840_000, signal });
    if (result.kind !== "json") throw new Error("The video model returned an unexpected binary response.");

    const url = videoResultUrl(result.data, model.api);
    if (!url) throw new Error(videoResultError(result.data) ?? "The video model returned no clip.");

    // Router's link expires in twelve hours, so the clip is copied locally.
    reportProgress(progress.id, { stage: "downloading" });
    const download = await downloadClip(url, apiKey);
    if (!download.ok) {
      const host = hostOf(url);
      throw new Error(`Could not download the clip (HTTP ${download.status}${host ? ` from ${host}` : ""}).`);
    }

    const type = download.headers.get("content-type") ?? "video/mp4";
    const bytes = Buffer.from(await download.arrayBuffer());
    if (bytes.byteLength === 0) throw new Error("The video download was empty.");

    const src = dataUrl(bytes, type);

    return NextResponse.json({
      kind: "video",
      src,
      prompt: finalPrompt,
      sourcePrompt,
      enhanced,
      keyframes,
      mode,
      media: "video",
      model: model.id,
      requestId: result.requestId ?? null,
    });
  } catch (error) {
    if (signal?.aborted) {
      return NextResponse.json({ error: CANCELLED_MESSAGE, code: "cancelled" }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "The video render failed.";
    const requestId = requestIdOf(error);
    return NextResponse.json(
      { error: requestId ? `${message} Request ID: ${requestId}` : message, code: "video_failed" },
      { status: 502 },
    );
  }
}
