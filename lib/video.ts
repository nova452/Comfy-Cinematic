/**
 * Video models and the request shape Comfy Router forwards to MiniMax H3.
 *
 * The schema is unusual: everything the provider needs is a list of typed
 * content items, so a prompt, a character image, an audio bed and a motion
 * reference are all siblings in one array. Building that array is pure and
 * therefore testable — which matters here, because a wrong body is a paid 400.
 */

import { acceptsVideo, formatPromptSpec, parsePromptSpec } from "./brain.ts";

export const VIDEO_MODES = [
  { id: "free", label: "Free", note: "Text only, no references." },
  { id: "audio", label: "Audio Reference", note: "Drive the clip with audio." },
  { id: "video", label: "Video Reference", note: "Match motion from a clip." },
] as const;

export type VideoMode = (typeof VIDEO_MODES)[number]["id"];

/**
 * True when a stored prompt is the panel's own caption, not typed words.
 *
 * A reference render needs no prompt, and older frames recorded the caption
 * (`"Video Reference reference"`) in its place — a reuse must not hand that
 * back to the person as if they had written it.
 */
export function isReferenceCaption(text: string) {
  const trimmed = text.trim();
  return VIDEO_MODES.some((mode) => mode.id !== "free" && trimmed === `${mode.label} reference`);
}

/**
 * Where a render runs.
 *
 * `router` posts a model request to Comfy Router. `local` runs an API-format
 * graph on the ComfyUI that `COMFY_BASE_URL` points at, through the Comfy SDK
 * — no credits, but the machine does the work.
 */
export type VideoProvider = "router" | "local";

/**
 * Output sizes H3 renders. `768P` is what Comfy calls 1k (1344×768 at 16:9)
 * and `480P` is the cheaper preview size the local graph can still do; `2K`
 * is Router's larger size.
 *
 * Router accepts exactly `768P` and `2K` for `minimax/minimax-h3` — anything
 * else is a 400 — so a model declares which of these it may be asked for and
 * the request builder never emits a value outside that set.
 */
export type VideoResolution = "480P" | "768P" | "2K";

/**
 * Which contract a Router model speaks.
 *
 * `minimax` is H3 native: a `content[]` array of typed items, a task document,
 * and the MP4 at `task.content.url`. `fal` is H3 Max: one flat body with a
 * plain `prompt`, and the MP4 at `video.url`. A body in the wrong shape is a
 * 422, so the builder and the reader both take this switch.
 */
export type VideoApi = "minimax" | "fal";

/** The three Router H3 flavours, in the order the toggle shows them. */
export const VIDEO_TIERS = [
  { id: "original", label: "Original" },
  { id: "max", label: "Max" },
  { id: "turbo", label: "Turbo" },
] as const;

export type VideoTier = (typeof VIDEO_TIERS)[number]["id"];

export type VideoModel = {
  id: string;
  label: string;
  short: string;
  note: string;
  provider: VideoProvider;
  /** Router only: the request/result contract. `minimax` when unset. */
  api?: VideoApi;
  /** Which H3 tier this entry is, when it belongs to the H3 card. */
  tier?: VideoTier;
  /** The card this entry is a tier of, e.g. `MiniMax H3`. */
  family?: string;
  modes: VideoMode[];
  ratio: string;
  resolution: VideoResolution;
  /** The shapes this entry accepts; every ratio when unset. */
  ratios?: string[];
  /** The sizes this entry may be asked for, cheapest first. */
  resolutions: VideoResolution[];
  /** False when the model takes a prompt and nothing else. */
  references?: boolean;
  /** Default clip length in seconds. */
  duration: number;
  /** Shortest clip the model will render. */
  minDuration: number;
  /** Longest clip the model will render. */
  maxDuration: number;
};

export const VIDEO_MODELS: VideoModel[] = [
  {
    id: "minimax/minimax-h3",
    label: "MiniMax H3",
    short: "H3",
    note: "Lightweight, open-weights video model from MiniMax.",
    provider: "router",
    api: "minimax",
    tier: "original",
    family: "MiniMax H3",
    modes: ["free", "audio", "video"],
    ratio: "16:9",
    resolution: "768P",
    resolutions: ["768P", "2K"],
    duration: 5,
    minDuration: 5,
    maxDuration: 15,
  },
  {
    id: "fal/h3-max",
    label: "MiniMax H3 Max",
    short: "Max",
    note: "fal's quality pass: more motion and detail, slower to finish.",
    provider: "router",
    api: "fal",
    tier: "max",
    family: "MiniMax H3",
    // The fal schema has no reference fields, so only plain prompts go out.
    references: false,
    modes: ["free"],
    ratio: "16:9",
    ratios: ["16:9", "1:1", "9:16"],
    resolution: "768P",
    resolutions: ["480P", "768P"],
    duration: 5,
    minDuration: 5,
    maxDuration: 15,
  },
  {
    id: "fal/h3-max-turbo",
    label: "MiniMax H3 Turbo",
    short: "Turbo",
    note: "The same fal pass tuned for speed. Cheapest per clip.",
    provider: "router",
    api: "fal",
    tier: "turbo",
    family: "MiniMax H3",
    references: false,
    modes: ["free"],
    ratio: "16:9",
    ratios: ["16:9", "1:1", "9:16"],
    resolution: "768P",
    resolutions: ["480P", "768P"],
    duration: 5,
    minDuration: 5,
    maxDuration: 15,
  },
  {
    id: "local/minimax-h3",
    label: "MiniMax H3 Local",
    short: "H3 local",
    note: "The same H3 graph on your own ComfyUI, via the Comfy SDK.",
    provider: "local",
    modes: ["free", "audio", "video"],
    ratio: "16:9",
    resolution: "768P",
    // The local graph's own dimension tables cover these two; 2K would be
    // several times the pixels on someone's GPU.
    resolutions: ["480P", "768P"],
    duration: 5,
    minDuration: 5,
    maxDuration: 15,
  },
  {
    // The ref5 graph (`lib/ref5.ts`) on the same local H3 install.
    id: "local/openjutsu",
    label: "Openjutsu Prime",
    short: "Openjutsu Prime",
    note: "It casts your characters into a clip. Up to 8 characters.",
    provider: "local",
    modes: ["video"],
    ratio: "16:9",
    resolution: "480P",
    resolutions: ["480P", "768P"],
    duration: 5,
    minDuration: 5,
    maxDuration: 15,
  },
];

export const OPENJUTSU_MODEL_ID = "local/openjutsu";

/** The plain local H3 graph: the entry a continuation can always land on. */
export const H3_LOCAL_MODEL_ID = "local/minimax-h3";

/**
 * What the panel opens on, and what a request without a model falls back to:
 * Openjutsu, the ref5 graph.
 *
 * It is the picker's first row, so the panel starts on the entry the list
 * leads with rather than on the H3 card that follows it.
 */
export const DEFAULT_VIDEO_MODEL = VIDEO_MODELS.find((model) => model.id === OPENJUTSU_MODEL_ID)!;

/**
 * The H3 card's three tiers, in toggle order, each with the entry it selects.
 *
 * They are three separate Router models with two different contracts, so the
 * picker shows one card and the toggle is what switches between them.
 */
export function h3TierModels() {
  return VIDEO_TIERS.map((tier) => ({
    ...tier,
    model: VIDEO_MODELS.find((model) => model.tier === tier.id)!,
  }));
}

/** The entries that are not a tier of a card, i.e. the local graph. */
export function standaloneVideoModels() {
  return VIDEO_MODELS.filter((model) => !model.tier);
}

/**
 * Aspect ratios H3 renders: 1:1, 3:4 and 4:3, 16:9 and 9:16 — plus Auto.
 *
 * The provider rejects anything else, so the picker only offers these; `2:3`
 * and `3:2` are not in its set. `w`/`h` is the shape the swatch is drawn at;
 * `adaptive` has none of its own.
 */
export type VideoRatio = { id: string; label: string; w: number; h: number };

export const VIDEO_RATIOS: VideoRatio[] = [
  { id: "3:4", label: "3:4", w: 3, h: 4 },
  { id: "9:16", label: "9:16", w: 9, h: 16 },
  { id: "4:3", label: "4:3", w: 4, h: 3 },
  { id: "16:9", label: "16:9", w: 16, h: 9 },
  { id: "1:1", label: "1:1", w: 1, h: 1 },
  { id: "adaptive", label: "Auto", w: 0, h: 0 },
];

export const DEFAULT_VIDEO_RATIO = "16:9";

/** A known ratio id, else the model's own — never something invented. */
export function findVideoRatio(
  id: unknown,
  fallback = DEFAULT_VIDEO_RATIO,
  allowed?: readonly string[],
): VideoRatio {
  const known = (value: unknown) => VIDEO_RATIOS.find((ratio) => ratio.id === value);
  const fallbackRatio = known(fallback) ?? VIDEO_RATIOS[0]!;
  const wanted = known(id) ?? fallbackRatio;
  if (!allowed || allowed.includes(wanted.id)) return wanted;
  return known(allowed[0]) ?? fallbackRatio;
}

/** The shapes one model accepts, for its picker. */
export function ratioOptions(model: VideoModel) {
  return model.ratios ? VIDEO_RATIOS.filter((ratio) => model.ratios!.includes(ratio.id)) : VIDEO_RATIOS;
}

/**
 * The shape a reference clip renders at.
 *
 * A motion reference decides the render's ratio, and the models' set is
 * finite: the clip is matched to the ratio nearest its own shape rather than
 * sent through at whatever the panel happened to be left on. Compared as logs,
 * so 2:1 is as far from 16:9 as 1:0.89 is. `Auto` is never the answer — a clip
 * already has a shape.
 */
export function videoRatioForSize(width: number, height: number) {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  const aspect = Math.log(width / height);
  let best: VideoRatio | undefined;
  let distance = Infinity;
  for (const ratio of VIDEO_RATIOS) {
    if (ratio.id === "adaptive") continue;
    const gap = Math.abs(Math.log(ratio.w / ratio.h) - aspect);
    if (gap < distance) {
      best = ratio;
      distance = gap;
    }
  }
  return best?.id;
}

export function videoRatioLabel(id: string) {
  return findVideoRatio(id).label;
}

/** Every output size the studio knows, cheapest first. */
export const VIDEO_RESOLUTIONS: { id: VideoResolution; label: string; note: string }[] = [
  { id: "480P", label: "480p", note: "832×480" },
  { id: "768P", label: "1k", note: "1344×768" },
  { id: "2K", label: "2K", note: "Sharpest" },
];

export const DEFAULT_VIDEO_RESOLUTION: VideoResolution = "768P";

/** The sizes one model may be asked for, for its picker. */
export function resolutionOptions(model: VideoModel) {
  return VIDEO_RESOLUTIONS.filter((option) => model.resolutions.includes(option.id));
}

/**
 * A known resolution, else the fallback — never something the provider cannot
 * take. Pass `allowed` to also keep the answer inside one model's own sizes.
 */
export function findVideoResolution(
  value: unknown,
  fallback = DEFAULT_VIDEO_RESOLUTION,
  allowed?: readonly VideoResolution[],
): VideoResolution {
  const wanted = typeof value === "string" ? value.trim().toUpperCase() : "";
  const match = VIDEO_RESOLUTIONS.find((option) => option.id === wanted)?.id;
  if (!match) return fallback;
  return !allowed || allowed.includes(match) ? match : fallback;
}

export function videoResolutionLabel(id: VideoResolution) {
  return VIDEO_RESOLUTIONS.find((option) => option.id === id)?.label ?? id;
}


/** Provider hard limits; a model's own range always sits inside these. */
export const MIN_DURATION = 4;
export const MAX_DURATION = 15;
export const MAX_VIDEO_IMAGES = 3;

/** Character references the local ref5 graph takes; it has no background slot. */
export const MAX_REF5_IMAGES = 8;

/**
 * Whether a render runs the ref5 graph (`lib/ref5.ts`): Openjutsu, except a
 * continuation, which renders past the clip on the plain H3 stack.
 */
export function isRef5Render(model: Pick<VideoModel, "id">, mode: VideoMode, continuation = false) {
  return model.id === OPENJUTSU_MODEL_ID && mode === "video" && !continuation;
}

/** How many character references a render takes. */
export function maxCharacterImages(model: Pick<VideoModel, "id">, mode: VideoMode, continuation: boolean) {
  return isRef5Render(model, mode, continuation) ? MAX_REF5_IMAGES : MAX_VIDEO_IMAGES;
}

/**
 * Whether a model can render a continuation.
 *
 * A continuation extends a clip on the plain H3 stack, so the entries that
 * speak H3 — Router's original and the local graph — take one. Openjutsu's
 * ref5 graph casts characters into a clip and has no continuation at all: a
 * clip it made is not offered Continue, and the panel never arms one there.
 */
export function supportsContinuation(model: Pick<VideoModel, "id" | "modes">) {
  return model.id !== OPENJUTSU_MODEL_ID && model.modes.includes("video");
}

/**
 * How much of a reference clip a continuation hands the model it renders with.
 *
 * A continuation only needs the run-up to the cut — 22 frames at 24 fps is the
 * second or so motion is conditioned on — while the prompt model still reads
 * the whole clip to know what is being continued.
 */
export const CONTINUATION_FRAMES = 22;

/** Every whole-second length this model can render, for the trim picker. */
export function durationOptions(model: VideoModel) {
  const options: number[] = [];
  for (let seconds = model.minDuration; seconds <= model.maxDuration; seconds += 1) {
    options.push(seconds);
  }
  return options;
}

/** Keep a stored duration inside the model's range. */
export function clampDuration(seconds: number, model: VideoModel) {
  return Math.min(model.maxDuration, Math.max(model.minDuration, Math.round(seconds)));
}

/**
 * What a reference sets, and therefore what the panel stops letting you pick.
 *
 * An audio bed decides its own length, so duration is fixed; a motion
 * reference decides both length and framing.
 */
export function lockedByMode(mode: VideoMode) {
  return { duration: mode !== "free", ratio: mode === "video" };
}

export function findVideoModel(id: string) {
  return VIDEO_MODELS.find((model) => model.id === id);
}

/**
 * Defaults for the local H3 workflow. The model picker's gear writes over
 * these; they are only what a fresh install starts from.
 */
export const LOCAL_MODEL_DEFAULTS = {
  unet: "fasth3_omniref_8step_pruned_int8_convrot.safetensors",
  clip: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
  steps: 8,
  refVideoEdge: 0,
} as const;

/**
 * Caps on a motion reference's short edge before H3 encodes it. `0` means the
 * render's own size, which is what the graph has always done. A clip already
 * under the cap keeps its own size: nothing is upscaled.
 */
export const REF_VIDEO_EDGES = [0, 288, 360, 480, 576, 720, 768, 1080] as const;

/**
 * Openjutsu Prime's caps. 544p is a hard limit: a bigger reference pushes a
 * render past ~32 minutes, so `0` (Match output) is held to it as well.
 */
export const OPENJUTSU_REF_VIDEO_LIMIT = 544;
export const OPENJUTSU_REF_VIDEO_EDGES = [0, 288, 360, 480, OPENJUTSU_REF_VIDEO_LIMIT] as const;

/**
 * Openjutsu Prime's two pipelines. `light` (ref6) is the default: it conditions
 * both passes on the original clip and the user's prompt, with no extra
 * render. `quality` (ref7) renders the targeted subjects as chroma-key
 * dummies, then renders the characters over that render, all on the ref2va
 * chain.
 */
export const OPENJUTSU_MODE_OPTIONS = [
  { id: "quality", label: "Quality", note: "A dummy pass on the clip, then the characters over it." },
  { id: "light", label: "Light", note: "One pass on the original clip." },
] as const;

export type OpenjutsuMode = (typeof OPENJUTSU_MODE_OPTIONS)[number]["id"];

/**
 * The two ways Openjutsu's prompt model is called, both from inside the graph.
 *
 * `gemini` is Comfy Router's Google Gemini node (`GeminiNodeV3`), at high
 * thinking; it takes each character sheet as its own image slot, so there is
 * no batch node. `openrouter` is the `ComfyUI-OpenRouter-Node` call the graph
 * has always made, with Kimi writing both prompts.
 */
export const OPENJUTSU_PROMPT_APIS = [
  { id: "gemini", label: "Comfy", note: "Comfy Router's Gemini 3.8 Flash, high thinking. The default." },
  { id: "openrouter", label: "OR", note: "OpenRouter Kimi, with the OpenRouter key." },
] as const;

export type OpenjutsuPromptApi = (typeof OPENJUTSU_PROMPT_APIS)[number]["id"];

/**
 * What the OpenRouter node raises when the prompt model answers without a
 * prompt twice in a row (`ComfyUI-OpenRouter-Node`'s `BLANK_OUTPUT_MESSAGE`).
 */
export const BLANK_PROMPT_MESSAGE = "The prompt model returned no usable prompt twice in a row";

/** Whether a render failed because the prompt model kept answering blank. */
export function isBlankPromptError(message: string) {
  return message.includes(BLANK_PROMPT_MESSAGE);
}

/**
 * The H3 regenerate refiner LoRA the upscale pass appends, in either rank
 * release. Verify picks whichever the target has; the first is the default.
 */
export const OPENJUTSU_REFINER_LORAS = [
  "minimax_h3_open_regenerate_2k_refiner_rank_16_bf16.safetensors",
  "minimax_h3_open_regenerate_2k_refiner_rank_384_bf16.safetensors",
] as const;

/** The second pass's checkpoint and LoRA, which Extras starts filled in with. */
export const REF2VA_UNET_DEFAULT = "minimax_h3_ref2va_pruned_int8_convrot.safetensors";
export const REF2VA_LORA_DEFAULT = "pika_h3_flex_ref2va_v1_bf16.safetensors";

/** The upscale pass's latent upscaler when Extras and `H3_LATENT_UPSCALER` leave it blank. */
export const REF5_UPSCALER_DEFAULT = "minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors";

/** Whether a loader name is one of the refiner releases, in any subfolder. */
export function isRefinerLora(name: string) {
  const file = name.split(/[\\/]/).pop() ?? "";
  return (OPENJUTSU_REFINER_LORAS as readonly string[]).includes(file);
}

/** What a fresh Openjutsu install starts from: Light, no upscale, Gemini. */
export const OPENJUTSU_DEFAULTS = {
  mode: "light",
  upscale: false,
  promptApi: "gemini",
} as const satisfies {
  mode: OpenjutsuMode;
  upscale: boolean;
  promptApi: OpenjutsuPromptApi;
};

export type LocalModelConfig = {
  unet: string;
  clip: string;
  steps: number;
  /** Cap on the motion reference's short edge, or 0 for the output's own. */
  refVideoEdge?: number;
  /** OpenRouter key for Video Reference's ref5 graph; `OPENROUTER_API_KEY` fills a gap. */
  openRouterKey?: string;
  /** Openjutsu's pipeline: `quality` or `light`. */
  openjutsuMode?: OpenjutsuMode;
  /** Openjutsu's 2x upscale pass; only `true` (on) is stored, off is the default. */
  upscale?: boolean;
  /** Openjutsu's prompt model: Comfy Router Gemini (default) or the OpenRouter node. */
  promptApi?: OpenjutsuPromptApi;
  /** MiniMax H3 Local's reference rewrite model, as `provider/model/thinking`. */
  promptModel?: string;
  /** Openjutsu's second pass: the ref2va checkpoint, from the gear's Extras. */
  ref2vaUnet?: string;
  /** Openjutsu's second pass: the Pika LoRA, from the gear's Extras. */
  ref2vaLora?: string;
  /** Openjutsu's upscale pass: the latent upscaler, from the gear's Extras. */
  latentUpscaler?: string;
  /** Openjutsu's upscale pass: the refiner LoRA, from Extras or found by verify. */
  refinerLora?: string;
};

/** Fill a partial/unknown config from defaults, clamped to sane values. */
export function localModelConfig(value: unknown): LocalModelConfig {
  const source = (value ?? {}) as Record<string, unknown>;
  const unet = typeof source.unet === "string" ? source.unet.trim() : "";
  const clip = typeof source.clip === "string" ? source.clip.trim() : "";
  const raw = typeof source.steps === "number" ? source.steps : Number(source.steps);
  const steps = Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.round(raw))) : LOCAL_MODEL_DEFAULTS.steps;
  const edge = Number(source.refVideoEdge);
  const refVideoEdge = ([...REF_VIDEO_EDGES, ...OPENJUTSU_REF_VIDEO_EDGES] as number[]).includes(edge)
    ? edge
    : LOCAL_MODEL_DEFAULTS.refVideoEdge;
  const key = typeof source.openRouterKey === "string" ? source.openRouterKey.trim() : "";
  const openRouterKey = key && key.length <= 400 && !/\s/.test(key) ? key : undefined;
  const mode = source.openjutsuMode;
  // `flash` is Light's name from before the rename.
  const openjutsuMode: OpenjutsuMode | undefined =
    mode === "quality" || mode === "light" ? mode : mode === "flash" ? "light" : undefined;
  // Off is the default, so only an explicit on is worth keeping.
  const upscaleOn = source.upscale === true;
  // Gemini is the default, so only the OpenRouter choice is stored.
  const promptApi: OpenjutsuPromptApi | undefined = source.promptApi === "openrouter" ? "openrouter" : undefined;
  // The local H3 gear's reference rewrite model, kept only when it is one of
  // the allowlisted models that can watch a clip.
  const promptSpec = parsePromptSpec(typeof source.promptModel === "string" ? source.promptModel : "");
  const promptModel = promptSpec && acceptsVideo(promptSpec.brain) ? formatPromptSpec(promptSpec) : undefined;
  // Extras' file names: free text, as the target lists them; Verify checks them.
  const fileName = (value: unknown) => {
    const name = typeof value === "string" ? value.trim() : "";
    return name && name.length <= 400 && !/[\r\n]/.test(name) ? name : undefined;
  };
  const ref2vaUnet = fileName(source.ref2vaUnet);
  const ref2vaLora = fileName(source.ref2vaLora);
  const latentUpscaler = fileName(source.latentUpscaler);
  const refinerLora = fileName(source.refinerLora);

  return {
    unet: unet || LOCAL_MODEL_DEFAULTS.unet,
    clip: clip || LOCAL_MODEL_DEFAULTS.clip,
    steps,
    refVideoEdge,
    ...(openRouterKey ? { openRouterKey } : {}),
    ...(openjutsuMode ? { openjutsuMode } : {}),
    ...(upscaleOn ? { upscale: true } : {}),
    ...(promptApi ? { promptApi } : {}),
    ...(promptModel ? { promptModel } : {}),
    ...(ref2vaUnet ? { ref2vaUnet } : {}),
    ...(ref2vaLora ? { ref2vaLora } : {}),
    ...(latentUpscaler ? { latentUpscaler } : {}),
    ...(refinerLora ? { refinerLora } : {}),
  };
}

/** True when this model renders on the local ComfyUI instead of Router. */
export function isLocalVideoModel(model: VideoModel) {
  return model.provider === "local";
}

/**
 * A mode id as the label the panel uses.
 *
 * A stored recipe is untrusted and a project can outlive a build, so an id
 * this one no longer offers is shown as itself rather than as nothing.
 */
export function videoModeLabel(id: string) {
  return VIDEO_MODES.find((mode) => mode.id === id)?.label ?? id;
}

export type VideoReferences = {
  /** Reference images, as data URIs or public URLs. */
  images?: string[];
  /** Audio bed for Audio Reference mode. */
  audio?: string;
  /** Motion reference for Video Reference mode. */
  video?: string;
  /** Opening frame. Free mode only, and exclusive with reference images. */
  firstFrame?: string;
  /** Closing frame. Free mode only, and exclusive with reference images. */
  lastFrame?: string;
};

export type VideoRequest = {
  prompt: string;
  mode: VideoMode;
  ratio: string;
  duration: number;
  resolution: string;
  references?: VideoReferences;
  /** fal's own prompt-expansion effort. Required by the H3 Max schema. */
  expansion?: "balanced" | "quality";
};

/**
 * The exact body Router receives, for the model's own contract.
 *
 * `minimax` (H3 native): `ratio` must be concrete for text-to-video and is
 * ignored (treated as adaptive) when reference media is present, so it is only
 * forced in Free mode. Keyframe roles and `reference_*` roles are mutually
 * exclusive in one request, so a first/last frame wins over character and
 * background images.
 *
 * `fal` (H3 Max / Max Turbo): one flat body. `prompt_expansion_mode` is
 * required there, there are no reference fields at all, and `aspect_ratio` is
 * always concrete — the schema has no `adaptive`.
 */
export function buildVideoRequest(input: VideoRequest, api: VideoApi = "minimax"): Record<string, unknown> {
  const duration = Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(input.duration)));

  if (api === "fal") {
    return {
      prompt: input.prompt,
      aspect_ratio: input.ratio === "adaptive" ? "16:9" : input.ratio,
      duration,
      prompt_expansion_mode: input.expansion ?? "balanced",
      resolution: input.resolution.trim().toUpperCase() === "480P" ? "480P" : "768P",
    };
  }

  const content: Record<string, unknown>[] = [{ type: "text", text: input.prompt }];

  if (input.mode === "audio" && input.references?.audio) {
    content.push({
      type: "audio_url",
      role: "reference_audio",
      audio_url: { url: input.references.audio },
    });
  }

  if (input.mode === "video" && input.references?.video) {
    content.push({
      type: "video_url",
      role: "reference_video",
      video_url: { url: input.references.video },
    });
  }

  const firstFrame = input.mode === "free" ? input.references?.firstFrame : undefined;
  const lastFrame = input.mode === "free" ? input.references?.lastFrame : undefined;
  const hasKeyframes = Boolean(firstFrame || lastFrame);

  if (firstFrame) {
    content.push({ type: "image_url", role: "first_frame", image_url: { url: firstFrame } });
  }
  if (lastFrame) {
    content.push({ type: "image_url", role: "last_frame", image_url: { url: lastFrame } });
  }

  if (!hasKeyframes) {
    for (const url of input.references?.images ?? []) {
      content.push({ type: "image_url", role: "reference_image", image_url: { url } });
    }
  }

  const ratio = input.mode === "free" && !hasKeyframes && input.ratio === "adaptive" ? "16:9" : input.ratio;

  return {
    content,
    duration,
    ratio,
    // Router accepts exactly these two spellings for H3; anything else is a 400.
    resolution: input.resolution.trim().toUpperCase() === "2K" ? "2K" : "768P",
  };
}

/** True when keyframes are present, which makes reference images ineligible. */
export function usesKeyframes(references?: VideoReferences) {
  return Boolean(references?.firstFrame || references?.lastFrame);
}

/**
 * Snap a trim window inside the media and the model's limit.
 *
 * The trim dialog shows whole seconds, so fractional handles would produce
 * readouts like `14.1s`. The clip editor cuts a real file and wants tenths,
 * so `step` is configurable. Rounding happens here, once, instead of at
 * render time.
 */
export function snapWindow(
  startSeconds: number,
  endSeconds: number,
  totalSeconds: number,
  minWindow = 1,
  maxWindow = MAX_DURATION,
  step = 1,
) {
  const unit = Math.max(0.001, step);
  const round = (value: number) => Number((Math.round(value / unit) * unit).toFixed(3));
  const floor = (value: number) => Number((Math.floor(value / unit) * unit).toFixed(3));

  const ceiling = Math.max(unit, floor(totalSeconds));
  // A minimum longer than the media itself collapses to the whole clip.
  const minimum = Math.min(minWindow, ceiling);
  const limit = Math.min(maxWindow, ceiling);

  let start = Math.min(Math.max(0, round(startSeconds)), Math.max(0, ceiling - minimum));
  let end = Math.min(ceiling, round(endSeconds));

  if (end - start < minimum) end = Math.min(ceiling, round(start + minimum));
  if (end - start > limit) start = Math.max(0, round(end - limit));

  return { start: round(start), end: round(end) };
}

/**
 * Place a dragged trim window whose length and position snap separately.
 *
 * The length stays on `step` (whole seconds for a render), but where the
 * window sits moves on the finer `positionStep`, so dragging glides instead
 * of jumping a whole second at a time. `mode` says what is held: the far edge
 * stays put while one handle moves, and a move keeps the length.
 */
export function placeWindow(
  mode: "start" | "end" | "move",
  startSeconds: number,
  endSeconds: number,
  totalSeconds: number,
  minWindow: number,
  maxWindow: number,
  step: number,
  positionStep: number,
) {
  const unit = Math.max(0.001, step);
  const fine = Math.max(0.001, Math.min(unit, positionStep));
  const tidy = (value: number) => Number(value.toFixed(3));
  const onFine = (value: number) => tidy(Math.round(value / fine) * fine);

  const longest = Math.max(unit, Math.floor(totalSeconds / unit) * unit);
  const shortest = Math.min(Math.max(unit, minWindow), longest);
  const limit = Math.min(Math.max(shortest, maxWindow), longest);
  const lengthOf = (raw: number, room: number) => {
    const fits = Math.max(shortest, Math.floor(room / unit) * unit);
    return Math.min(limit, fits, Math.max(shortest, Math.round(raw / unit) * unit));
  };

  if (mode === "start") {
    const end = Math.min(totalSeconds, endSeconds);
    const length = lengthOf(end - startSeconds, end);
    const start = Math.max(0, tidy(end - length));
    return { start, end: tidy(start + length) };
  }
  if (mode === "end") {
    const length = lengthOf(endSeconds - startSeconds, totalSeconds - Math.max(0, startSeconds));
    // A window too long for the room left slides back rather than overrunning.
    const start = Math.min(Math.max(0, startSeconds), Math.max(0, totalSeconds - length));
    return { start: tidy(start), end: tidy(start + length) };
  }
  const length = lengthOf(endSeconds - startSeconds, totalSeconds);
  const start = Math.min(Math.max(0, onFine(startSeconds)), Math.max(0, tidy(totalSeconds - length)));
  return { start, end: tidy(start + length) };
}

/** An `https:` link, or undefined when the value is not a URL we can fetch. */
function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where the finished MP4 is. MiniMax wraps the task (`task.content.url`); fal
 * answers a flat document (`video.url`) instead.
 */
export function videoResultUrl(data: unknown, api: VideoApi = "minimax"): string | undefined {
  if (!data || typeof data !== "object") return undefined;

  if (api === "fal") {
    const video = Reflect.get(data, "video");
    if (!video || typeof video !== "object") return undefined;
    return httpsUrl(Reflect.get(video, "url"));
  }

  const task = Reflect.get(data, "task");
  if (!task || typeof task !== "object") return undefined;
  if (Reflect.get(task, "status") !== "succeeded") return undefined;
  const content = Reflect.get(task, "content");
  if (!content || typeof content !== "object") return undefined;
  return httpsUrl(Reflect.get(content, "url"));
}

/** A failure message the provider gave us, if any. */
export function videoResultError(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const task = Reflect.get(data, "task");
  if (!task || typeof task !== "object") return undefined;
  const error = Reflect.get(task, "error");
  if (!error || typeof error !== "object") return undefined;
  const message = Reflect.get(error, "message");
  return typeof message === "string" && message ? message : undefined;
}
