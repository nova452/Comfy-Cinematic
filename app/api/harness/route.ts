import { NextResponse } from "next/server";
import {
  IMAGE_SYSTEM_PROMPT,
  buildBrainRequest,
  DEFAULT_BRAIN,
  parseBrainDecision,
  parseVideoPrompt,
  readBrainText,
  resolveBrain,
  type BrainDecision,
} from "../../../lib/brain";
import { fluxAssetUrl } from "../../../lib/flux-output";
import {
  DEFAULT_TOOL,
  MAX_IMAGE_REFERENCES,
  MAX_PROMPT,
  clampImageBatch,
  composePrompt,
  findImageRatio,
  findImageResolution,
  findImageTool,
  pickSubject,
  routePrompt,
} from "../../../lib/harness";
import { stylePhrase } from "../../../lib/projects";
import { runModel } from "../../../lib/router";
import { dataUrl } from "../../../lib/media-data";
import { activeEndpoint, endpointKey, readAccount, routerKey } from "../../../lib/account";
import { readLocalImageConfig } from "../../../lib/local-image-config";
import { runLocalImage } from "../../../lib/local-image";
import {
  STUDIO_SYSTEM_PROMPT,
  describePlan,
  describeStudioState,
  parseStudioAction,
  planFromPrompt,
} from "../../../lib/studio";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_MODEL = process.env.HARNESS_MODEL?.trim() || DEFAULT_BRAIN;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_REFERENCE_CHARS = 3_000_000;

type HarnessRequest = {
  prompt?: unknown;
  /** `chat` answers or presets the panel; it never renders. */
  mode?: unknown;
  /** The panel as the chat sees it, for "make it bigger" to have a meaning. */
  state?: unknown;
  style?: unknown;
  enhance?: unknown;
  brain?: unknown;
  imageModel?: unknown;
  ratio?: unknown;
  resolution?: unknown;
  batch?: unknown;
  reference?: unknown;
  references?: unknown;
  canvas?: unknown;
  characters?: unknown;
  character?: unknown;
  background?: unknown;
  /** The Create panel's Generate: always render, never answer. */
  render?: unknown;
};

function requestIdOf(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const requestId = Reflect.get(error, "requestId");
  return typeof requestId === "string" ? requestId : undefined;
}

export async function POST(request: Request) {
  let body: HarnessRequest;
  try {
    body = (await request.json()) as HarnessRequest;
  } catch {
    return NextResponse.json({ error: "Send a JSON request." }, { status: 400 });
  }

  const sourcePrompt = typeof body.prompt === "string" ? body.prompt.replace(/\s+/g, " ").trim() : "";
  if (sourcePrompt.length < 2) {
    return NextResponse.json({ error: "Send a question or a description." }, { status: 400 });
  }
  if (sourcePrompt.length > MAX_PROMPT) {
    return NextResponse.json({ error: `Keep the prompt under ${MAX_PROMPT} characters.` }, { status: 400 });
  }

  const style = typeof body.style === "string" ? body.style.slice(0, 32) : "none";
  const enhance = body.enhance === true;
  // The chat branch returned above, so anything still here came from a render
  // panel — and Generate is never a question. `render` stays as an explicit
  // marker, but a client that does not send it is still a render request, which
  // is what keeps an older bundle from turning the button into a chat reply.
  const forcedRender = body.render !== false;

  const requestedBrain = typeof body.brain === "string" ? body.brain : "";
  const brain = resolveBrain(requestedBrain, DEFAULT_MODEL);
  if (!brain) {
    return NextResponse.json({ error: "That model is not in the picker list." }, { status: 400 });
  }

  // A chat turn stops here: it answers or hands back a panel setup, and it can
  // never reach the render code below. That is what makes the chat safe to give
  // control of the panel to: there is no path from a message to a paid call.
  if (body.mode === "chat") {
    return chatTurn(await routerKey(request), brain, sourcePrompt, body.state);
  }

  const characterList = Array.isArray(body.characters)
    ? body.characters
    : typeof body.character === "string"
      ? [body.character]
      : [];
  const characters = characterList.filter((item): item is string => typeof item === "string" && item.length > 0);
  const background = typeof body.background === "string" ? body.background : "";
  const referenceList = Array.isArray(body.references)
    ? body.references
    : typeof body.references === "string"
      ? [body.references]
      : typeof body.reference === "string"
        ? [body.reference]
        : [];
  const references = referenceList
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .slice(0, MAX_IMAGE_REFERENCES);
  const canvas = typeof body.canvas === "string" ? body.canvas : "";

  if (characters.length > 3) {
    return NextResponse.json({ error: "At most three character references." }, { status: 400 });
  }
  if (referenceList.length > MAX_IMAGE_REFERENCES) {
    return NextResponse.json({ error: `At most ${MAX_IMAGE_REFERENCES} reference images.` }, { status: 400 });
  }

  for (const [label, value] of [
    ["character", characters.join("")],
    ["background", background],
    ["reference", references.join("")],
    ["canvas", canvas],
  ] as const) {
    if (!value) continue;
    if (value.length > MAX_REFERENCE_CHARS * 4) {
      return NextResponse.json({ error: `The ${label} references are too large.` }, { status: 400 });
    }
  }

  for (const character of characters) {
    if (character.length < 64 || character.length > MAX_REFERENCE_CHARS || !BASE64.test(character)) {
      return NextResponse.json({ error: "A character reference is not a valid image." }, { status: 400 });
    }
  }
  if (background && (background.length < 64 || background.length > MAX_REFERENCE_CHARS || !BASE64.test(background))) {
    return NextResponse.json({ error: "The background reference is not a valid image." }, { status: 400 });
  }
  for (const reference of references) {
    if (reference.length < 64 || reference.length > MAX_REFERENCE_CHARS || !BASE64.test(reference)) {
      return NextResponse.json({ error: "A reference image is not a valid image." }, { status: 400 });
    }
  }
  if (canvas && (canvas.length < 64 || canvas.length > MAX_REFERENCE_CHARS || !BASE64.test(canvas))) {
    return NextResponse.json({ error: "The canvas image is not a valid image." }, { status: 400 });
  }

  const tool = findImageTool(typeof body.imageModel === "string" ? body.imageModel : "") ?? DEFAULT_TOOL;
  const local = tool.provider === "local";
  const ratio = findImageRatio(body.ratio, tool.aspectRatio, tool.ratios);
  const resolution = findImageResolution(body.resolution, tool.resolution, tool.resolutions);
  const batch = clampImageBatch(body.batch, tool.maxBatch);
  // The canvas decides the shape; Router's `auto` follows image 1.
  const renderRatio = canvas ? "auto" : ratio;
  // The local edit graph takes the canvas plus any reference images; neither
  // graph has a character or background slot.
  if (local && (characters.length > 0 || background)) {
    return NextResponse.json(
      { error: `${tool.label} takes reference images, not a character or background slot.` },
      { status: 400 },
    );
  }
  if (local && references.length > 0 && !canvas) {
    return NextResponse.json(
      { error: `${tool.label} renders from a text prompt only. Turn Edit on to use reference images.` },
      { status: 400 },
    );
  }

  const apiKey = await routerKey(request);
  if (!apiKey && !local) {
    // Without a key the brain cannot run, but the local router can still answer.
    const fallback = routePrompt(sourcePrompt);
    if (!forcedRender && fallback.intent === "answer") {
      return NextResponse.json({
        kind: "answer",
        answer: fallback.answer,
        route: { intent: "answer", reason: "No API key: answered by the local fallback.", brain: null },
      });
    }
    return NextResponse.json(
      { error: "Sign in with your Comfy Router API key (top right) to render.", code: "missing_key" },
      { status: 503 },
    );
  }

  let decision: BrainDecision;
  let reason: string;
  let brainError: string | undefined;

  if (canvas) {
    // An edit instruction is the prompt, verbatim; the brain would only risk
    // answering it instead of editing.
    decision = { intent: "image", prompt: sourcePrompt };
    reason = "Canvas mode keeps the edit instruction verbatim.";
    brainError = "Canvas mode";
  } else if (forcedRender) {
    // Create never routes. Pressing Generate is a render instruction, so the
    // brain is never asked whether this was a question — it is only asked to
    // sharpen the wording, and only when the flavor toggle asked for it.
    decision = { intent: "image", prompt: sourcePrompt };
    reason = "Generate was pressed: the typed prompt is rendered as written.";
    if (enhance && brain) {
      try {
        const result = await runModel(apiKey, 
          brain,
          buildBrainRequest(brain, sourcePrompt, IMAGE_SYSTEM_PROMPT),
          { timeoutMs: 60_000 },
        );
        const text = result.kind === "json" ? readBrainText(brain, result.data) : undefined;
        const rewritten = text ? parseVideoPrompt(text) : undefined;
        if (rewritten) {
          decision = { intent: "image", prompt: rewritten };
          reason = "The flavor rewrote this into a render prompt.";
        }
      } catch (error) {
        brainError = error instanceof Error ? error.message : "The brain failed.";
      }
    }
  } else if (!apiKey) {
    // A local render needs no Router key; the deterministic router still reads
    // the prompt, so questions are answered instead of rendered — unless
    // Generate was pressed, which is a render request by definition.
    const fallback = routePrompt(sourcePrompt);
    if (fallback.intent === "answer") {
      if (!forcedRender) {
        return NextResponse.json({
          kind: "answer",
          answer: fallback.answer,
          route: { intent: "answer", reason: "No API key: answered by the local fallback.", brain: null },
        });
      }
      decision = { intent: "image", prompt: sourcePrompt };
    } else {
      decision = { intent: "image", prompt: fallback.prompt };
    }
    reason = "No API key: the local router asked for a render.";
    brainError = "No API key";
  } else {
    try {
      const result = await runModel(apiKey, brain, buildBrainRequest(brain, sourcePrompt), { timeoutMs: 60_000 });
      if (result.kind !== "json") throw new Error("The brain returned a binary response.");

      const text = readBrainText(brain, result.data);
      const parsed = text ? parseBrainDecision(text) : undefined;
      if (!parsed) throw new Error("The brain returned no usable decision.");

      decision = parsed;
      reason =
        parsed.intent === "image"
          ? enhance
            ? "The brain rewrote this into a render prompt."
            : "The brain read this as a render and kept your wording."
          : forcedRender
            ? "Generate was pressed, so the typed prompt is rendered even though the brain read it as a question."
            : "The brain answered this one itself.";
      if (parsed.intent === "answer" && forcedRender) {
        decision = { intent: "image", prompt: sourcePrompt };
      }
    } catch (error) {
      brainError = error instanceof Error ? error.message : "The brain failed.";

      // Keep the app useful when the brain model is unavailable.
      const fallback = routePrompt(sourcePrompt);
      if (fallback.intent === "answer") {
        if (!forcedRender) {
          return NextResponse.json({
            kind: "answer",
            answer: fallback.answer,
            route: {
              intent: "answer",
              reason: `Brain unavailable (${brainError}); answered by the local fallback.`,
              brain: null,
            },
          });
        }
        decision = { intent: "image", prompt: sourcePrompt };
      } else {
        decision = { intent: "image", prompt: fallback.prompt };
      }
      reason = `Brain unavailable (${brainError}); the local router asked for a render.`;
    }
  }

  if (decision.intent === "answer") {
    if (!forcedRender) {
      return NextResponse.json({
        kind: "answer",
        answer: decision.answer,
        route: { intent: "answer", reason, brain: brainError ? null : brain },
      });
    }
    // Generate was pressed: render the typed words instead of replying.
    decision = { intent: "image", prompt: sourcePrompt };
  }

  // The toggle is the contract: on, the model's rewrite is used; off, the
  // typed prompt goes through untouched.
  const subject = pickSubject(decision, sourcePrompt, enhance);
  const imagePrompt = composePrompt(subject, stylePhrase(style), {
    canvas: Boolean(canvas),
    references: references.length,
    characters: characters.length,
    background: Boolean(background),
  });

  try {
    if (local) {
      const account = await readAccount(request);
      const endpoint = activeEndpoint(account);
      if (!endpoint) {
        return NextResponse.json(
          {
            error:
              "Workflow renders need a Comfy deployment (Settings) or COMFY_BASE_URL pointing at your ComfyUI.",
            code: "missing_local_endpoint",
          },
          { status: 503 },
        );
      }

      const canvasDataUri = canvas ? `data:image/jpeg;base64,${canvas}` : undefined;
      const localInput = {
        prompt: imagePrompt,
        ratio: renderRatio,
        resolution,
        batch,
        ...(canvasDataUri ? { canvas: canvasDataUri } : {}),
        // The edit graph edits the canvas (image 0) and treats these as the
        // further references its node offers.
        ...(canvasDataUri && references.length > 0
          ? { images: references.map((item) => `data:image/jpeg;base64,${item}`) }
          : {}),
      };
      const localOptions = {
        // A hosted deployment refuses an anonymous /api/v2/jobs, so the
        // signed-in key goes with it; a local ComfyUI only takes its own.
        apiKey: endpointKey(account),
        baseUrl: endpoint,
        config: await readLocalImageConfig(request),
      };
      // A text-to-image graph batches internally; the edit graph has one
      // latent, so a batch is that many jobs.
      const runs =
        canvas && batch > 1
          ? Array.from({ length: batch }, (_, index) =>
              runLocalImage(localInput, { ...localOptions, seed: 42 + index }),
            )
          : [runLocalImage(localInput, localOptions)];
      const rendered = await Promise.all(runs);
      const images = rendered.flatMap((result) => result.images);
      if (images.length === 0) throw new Error("The local render returned no images.");
      const srcs = images.map((image) => dataUrl(image.bytes, image.contentType));

      return NextResponse.json({
        kind: "image",
        src: srcs[0],
        srcs,
        prompt: imagePrompt,
        sourcePrompt,
        enhanced: enhance,
        media: "image",
        style,
        route: {
          intent: "image",
          reason,
          brain: brainError ? null : brain,
          tool: {
            id: tool.id,
            label: tool.label,
            model: tool.model,
            aspectRatio: renderRatio,
            resolution,
          },
        },
        requestId: rendered[0]?.requestId ?? null,
      });
    }

    const referenceBase64 =
      references.length > 0 ? references : [...characters, ...(background ? [background] : [])];
    const usedReferences = canvas ? [canvas, ...referenceBase64] : referenceBase64;

    const input: Record<string, unknown> = {
      prompt: imagePrompt,
      aspect_ratio: renderRatio,
      resolution,
    };

    if (usedReferences.length > 0) input.images = usedReferences;

    // FLUX 3 returns one image per call, so a batch is N calls.
    const results = await Promise.all(
      Array.from({ length: batch }, () => runModel(apiKey, tool.model, input, { timeoutMs: 300_000 })),
    );

    const srcs = await Promise.all(
      results.map(async (result) => {
        if (result.kind !== "json") throw new Error("The image model returned an unexpected binary response.");

        const url = fluxAssetUrl(result.data);
        if (!url) throw new Error("The image model returned no image.");

        const image = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
        if (!image.ok) throw new Error(`Could not download the render (${image.status}).`);

        const type = image.headers.get("content-type") ?? "image/png";
        if (!type.startsWith("image/")) throw new Error("The model returned something that is not an image.");

        return dataUrl(new Uint8Array(await image.arrayBuffer()), type);
      }),
    );

    return NextResponse.json({
      kind: "image",
      src: srcs[0],
      srcs,
      prompt: imagePrompt,
      sourcePrompt,
      enhanced: enhance,
      style,
      route: {
        intent: "image",
        reason,
        brain: brainError ? null : brain,
        tool: {
          id: tool.id,
          label: tool.label,
          model: tool.model,
          aspectRatio: renderRatio,
          resolution,
        },
      },
      requestId: results[0]?.requestId ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The render failed.";
    const requestId = requestIdOf(error);
    return NextResponse.json(
      { error: requestId ? `${message} Request ID: ${requestId}` : message, code: "render_failed" },
      { status: 502 },
    );
  }
}

/**
 * One chat turn: an answer, or a plan that presets the panel.
 *
 * Deliberately never renders. The reply is the model's text or a description
 * built from the validated plan, so it cannot promise an image that no code
 * would ever produce. Without a Router key the deterministic router still
 * answers questions and still fills the Create prompt, because presetting is
 * free and the panel is still useful.
 */
async function chatTurn(apiKey: string | undefined, brain: string, message: string, state: unknown) {
  const stateLine = describeStudioState(state);
  const input = stateLine ? `${stateLine}\n\n${message}` : message;
  let brainError: string | undefined;

  if (apiKey) {
    try {
      const result = await runModel(apiKey, brain, buildBrainRequest(brain, input, STUDIO_SYSTEM_PROMPT), {
        timeoutMs: 60_000,
      });
      if (result.kind !== "json") throw new Error("The brain returned a binary response.");

      const text = readBrainText(brain, result.data);
      const action = text ? parseStudioAction(text) : undefined;
      if (!action) throw new Error("The brain returned no usable action.");

      if (action.action === "answer") {
        return NextResponse.json({
          kind: "answer",
          answer: action.answer,
          route: { intent: "answer", reason: "The brain answered this one itself.", brain },
        });
      }

      return NextResponse.json({
        kind: "plan",
        plan: action.plan,
        reply: describePlan(action.plan),
        route: {
          intent: "plan",
          reason: "The brain preset the panel. Chat mode never renders.",
          brain,
        },
      });
    } catch (error) {
      brainError = error instanceof Error ? error.message : "The brain failed.";
    }
  }

  // The local router reads the message for free: a question becomes an answer,
  // and a description becomes the Create prompt with nothing else touched.
  const fallback = routePrompt(message);
  const reason = brainError
    ? `Brain unavailable (${brainError}); answered by the local fallback.`
    : "No API key: answered by the local fallback.";

  if (fallback.intent === "answer") {
    return NextResponse.json({
      kind: "answer",
      answer: fallback.answer,
      route: { intent: "answer", reason, brain: null },
    });
  }

  const plan = planFromPrompt(fallback.prompt);
  if (plan) {
    return NextResponse.json({
      kind: "plan",
      plan,
      reply: describePlan(plan),
      route: {
        intent: "plan",
        reason: brainError
          ? `Brain unavailable (${brainError}); the local router filled the Create prompt.`
          : "No API key: the local router filled the Create prompt.",
        brain: null,
      },
    });
  }

  return NextResponse.json({
    kind: "answer",
    answer: "Send a little more detail and I can set that up.",
    route: { intent: "answer", reason, brain: null },
  });
}
