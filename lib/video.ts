/**
 * Video models and the request shape Comfy Router forwards to MiniMax H3.
 *
 * The schema is unusual: everything the provider needs is a list of typed
 * content items, so a prompt, a character image, an audio bed and a motion
 * reference are all siblings in one array. Building that array is pure and
 * therefore testable — which matters here, because a wrong body is a paid 400.
 */

export const VIDEO_MODES = [
  { id: "free", label: "Free", note: "Text only. No reference media." },
  { id: "audio", label: "Audio Reference", note: "Drive the clip from an audio track." },
  { id: "video", label: "Video Reference", note: "Match motion and pacing from a clip." },
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
    note: "MiniMax H3 is a lightweight, open-weights video generation model from MiniMax.",
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
    note: "fal's quality pass on the same model: prompt only, 480P or 768P, 5–15s. Fuller motion and detail, slower to finish.",
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
    note: "The same fal pass tuned for speed: prompt only, 480P or 768P. Cheapest per clip, best for previews and iteration.",
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
    note: "The same H3 graph on your own ComfyUI or a Comfy deployment, through the Comfy SDK.",
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
];

export const DEFAULT_VIDEO_MODEL = VIDEO_MODELS[0]!;

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
} as const;

export type LocalModelConfig = { unet: string; clip: string; steps: number };

/** Fill a partial/unknown config from defaults, clamped to sane values. */
export function localModelConfig(value: unknown): LocalModelConfig {
  const source = (value ?? {}) as Record<string, unknown>;
  const unet = typeof source.unet === "string" ? source.unet.trim() : "";
  const clip = typeof source.clip === "string" ? source.clip.trim() : "";
  const raw = typeof source.steps === "number" ? source.steps : Number(source.steps);
  const steps = Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.round(raw))) : LOCAL_MODEL_DEFAULTS.steps;

  return {
    unet: unet || LOCAL_MODEL_DEFAULTS.unet,
    clip: clip || LOCAL_MODEL_DEFAULTS.clip,
    steps,
  };
}

/** True when this model renders on the local ComfyUI instead of Router. */
export function isLocalVideoModel(model: VideoModel) {
  return model.provider === "local";
}

export function videoModeLabel(id: VideoMode) {
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
