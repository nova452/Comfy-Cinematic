/**
 * Project model shared by the server store and the canvas client.
 *
 * Kept pure and dependency-free so the rules that matter — where a new frame
 * lands, what a project may contain, which image paths are trusted — are unit
 * tested rather than discovered at runtime.
 */

import { assetKindFrom, MAX_UPLOADS } from "./assets.ts";
import { isReferenceCaption } from "./video.ts";

export const FRAME_SIZE = 512;
export const FRAME_GAP = 32;
export const GRID_COLUMNS = 3;
export const MAX_FRAMES = 48;
export const MAX_MESSAGES = 200;
export const MAX_NAME = 80;

/**
 * Longest prompt a frame may carry.
 *
 * Much larger than `MAX_PROMPT`, which caps what a person types: a reference
 * clip is rendered from a six-section rewrite, and that will not fit in 900
 * characters.
 */
export const MAX_FRAME_PROMPT = 4000;

/**
 * Media this app wrote: images, and MP4/WebM clips from the video route.
 *
 * `media:` is a blob in this browser's own store; `/api/renders/` is what an
 * older build wrote to disk, kept so an imported project still opens.
 */
export const RENDER_SRC =
  /^(media:[a-f0-9-]{8,64}\.(png|jpg|jpeg|webp|mp4|webm)|\/api\/renders\/[a-f0-9-]{8,64}\.(png|jpg|jpeg|webp|mp4|webm))$/i;

/**
 * Everything the library can hold: the frame types plus the audio uploads the
 * video route never writes. Kept separate so an .mp3 can never be a frame.
 */
export const ASSET_SRC =
  /^(media:[a-f0-9-]{8,64}\.(png|jpg|jpeg|webp|mp4|webm|mp3|wav|m4a)|\/api\/renders\/[a-f0-9-]{8,64}\.(png|jpg|jpeg|webp|mp4|webm|mp3|wav|m4a))$/i;

/** True when a stored source is a clip rather than a still. */
export function isVideoSrc(src: string) {
  return /\.(mp4|webm)$/i.test(src);
}

const PROJECT_ID = /^[a-f0-9-]{8,64}$/i;

export type Frame = {
  id: string;
  src: string;
  /** The prompt the model was actually given, after any rewrite. */
  prompt: string;
  /** What the person typed, before enhancement. */
  sourcePrompt?: string;
  /** True when the brain rewrote the prompt. */
  enhanced?: boolean;
  /** Everything else the call was made with, so it can be made again. */
  recipe?: FrameRecipe;
  /** Saved reference images used as characters, if any. */
  characterSrcs?: string[];
  /** A saved reference image used as the setting, if any. */
  backgroundSrc?: string;
  /** The single Create-tab reference image, used for a character, object or place. */
  referenceSrc?: string;
  /** The Create-tab reference images, in the order they were sent. */
  referenceSrcs?: string[];
  /** Canvas mode: the image that was edited. */
  canvasSrc?: string;
  /** "video" when the frame came from the video route. */
  media?: "image" | "video";
  /** Length of a generated clip, in whole seconds. */
  seconds?: number;
  style: string;
  model: string;
  x: number;
  y: number;
  createdAt: number;
};

/** The tabs a frame can come from. */
export const FRAME_TABS = ["create", "video"] as const;
export type FrameTab = (typeof FRAME_TABS)[number];

/** The video route's modes, mirrored so a stored recipe is never trusted. */
export const FRAME_MODES = ["free", "audio", "video"] as const;

/**
 * What a frame was made from.
 *
 * `Frame.prompt` holds the text the model actually saw — a still's is the
 * enhanced prompt, a reference clip's is the six-section rewrite — and this
 * holds the rest of the call: which tab, which style, which enhancer, and the
 * size and timing that were asked for. The viewer reads it to show settings
 * instead of guessing them, and Reuse replays it.
 */
export type FrameRecipe = {
  tab: FrameTab;
  /** Create tab: the style id whose phrase was appended. */
  style?: string;
  /** Create tab: the image model the still was made with. */
  image?: string;
  /** Create tab: the render was an edit of a canvas image. */
  canvas?: boolean;
  /** The enhancer that wrote the prompt; null when it went through as typed. */
  flavor?: string | null;
  /** The shape the call asked for. */
  ratio?: string;
  resolution?: string;
  /** Create tab: images asked for in one press, 1–4. */
  batch?: number;
  /** Video tab: the model call, whole. */
  video?: {
    model: string;
    mode: string;
    ratio: string;
    resolution: string;
    /** Whole seconds, as the route validates it. */
    duration: number;
  };
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
};

/**
 * A file the person uploaded, kept in the project's library.
 *
 * Uploads are kept in this browser's media store beside the renders, so
 * `src` is a `media:` source rather than an object URL that dies with the tab.
 */
export type ProjectAsset = {
  id: string;
  kind: "image" | "video" | "audio";
  name: string;
  src: string;
  createdAt: number;
  /** Whole seconds, for clips and tracks. */
  seconds?: number;
};

export type Project = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  frames: Frame[];
  messages: Message[];
  /** Uploads, so the library survives a reload. */
  assets: ProjectAsset[];
  /** Ids of the assets kept in Saved: `upload:…` and `render:…`. */
  saved: string[];
};

export type ProjectSummary = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  count: number;
  preview?: string;
};

export const STYLES = [
  { id: "none", label: "No style", phrase: "" },
  { id: "cinematic", label: "Cinematic film", phrase: "cinematic film still, anamorphic, subtle grain" },
  { id: "photo", label: "Photoreal", phrase: "photorealistic, natural light, sharp detail" },
  { id: "illustration", label: "Illustration", phrase: "flat vector illustration, bold shapes, limited palette" },
  { id: "neon", label: "Neon noir", phrase: "neon noir, wet asphalt reflections, high contrast" },
  { id: "pastel", label: "Pastel 16mm", phrase: "pastel 16mm film, soft focus, gentle grain" },
  { id: "documentary", label: "Documentary", phrase: "documentary photography, candid, available light" },
] as const;

export type StyleId = (typeof STYLES)[number]["id"];

export function stylePhrase(id: string) {
  return STYLES.find((style) => style.id === id)?.phrase ?? "";
}

export function isProjectId(value: string) {
  return PROJECT_ID.test(value);
}

export function normalizeName(value: string) {
  const name = value.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return name || "Untitled project";
}

function toTime(value: unknown, fallback = Date.now()) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function toNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A short id or label out of untrusted JSON. */
function shortText(value: unknown, max: number) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, max) : undefined;
}

/**
 * A stored recipe, re-validated field by field.
 *
 * A recipe is only a record of a call that already succeeded, so an unexpected
 * value is dropped rather than repaired: a wrong ratio would make the next
 * render fail paid, and the defaults are always legal.
 */
function normalizeRecipe(raw: unknown): FrameRecipe | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const tab = FRAME_TABS.find((candidate) => candidate === value.tab);
  if (!tab) return undefined;

  const recipe: FrameRecipe = { tab };
  const style = shortText(value.style, 32);
  if (style) recipe.style = style;
  const image = shortText(value.image, 64);
  if (image) recipe.image = image;
  if (value.canvas === true) recipe.canvas = true;
  if (value.flavor === null) recipe.flavor = null;
  else {
    const flavor = shortText(value.flavor, 64);
    if (flavor) recipe.flavor = flavor;
  }
  const ratio = shortText(value.ratio, 16);
  if (ratio) recipe.ratio = ratio;
  const resolution = shortText(value.resolution, 16);
  if (resolution) recipe.resolution = resolution;
  const batch = Math.round(toNumber(value.batch, 0));
  if (batch >= 1) recipe.batch = Math.min(4, batch);

  const video = value.video;
  if (video && typeof video === "object") {
    const clip = video as Record<string, unknown>;
    const model = shortText(clip.model, 64);
    if (model) {
      recipe.video = {
        model,
        mode: FRAME_MODES.find((candidate) => candidate === clip.mode) ?? "free",
        ratio: shortText(clip.ratio, 16) ?? "",
        resolution: shortText(clip.resolution, 16) ?? "",
        duration: Math.max(1, Math.min(60, Math.round(toNumber(clip.duration, 1)))),
      };
    }
  }

  return recipe;
}

function normalizeFrame(raw: unknown): Frame | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const src = typeof value.src === "string" ? value.src : "";
  if (!RENDER_SRC.test(src)) return undefined;
  const characterSrc = typeof value.characterSrc === "string" ? value.characterSrc : "";
  const backgroundSrc = typeof value.backgroundSrc === "string" ? value.backgroundSrc : "";
  const referenceSrc = typeof value.referenceSrc === "string" ? value.referenceSrc : "";
  const canvasSrc = typeof value.canvasSrc === "string" ? value.canvasSrc : "";

  // `characterSrc` is the pre-multi-reference field; keep reading it so older
  // projects still show their badge.
  const characterSrcs = Array.isArray(value.characterSrcs)
    ? value.characterSrcs.filter((item): item is string => typeof item === "string" && RENDER_SRC.test(item))
    : RENDER_SRC.test(characterSrc)
      ? [characterSrc]
      : [];
  const referenceSrcs = Array.isArray(value.referenceSrcs)
    ? value.referenceSrcs
        .filter((item): item is string => typeof item === "string" && RENDER_SRC.test(item))
        .slice(0, 4)
    : RENDER_SRC.test(referenceSrc)
      ? [referenceSrc]
      : [];

  const sourcePrompt =
    typeof value.sourcePrompt === "string" ? value.sourcePrompt.slice(0, 900) : undefined;

  return {
    id: typeof value.id === "string" && value.id ? value.id.slice(0, 64) : crypto.randomUUID(),
    src,
    prompt:
      typeof value.prompt === "string" ? value.prompt.slice(0, MAX_FRAME_PROMPT) : "",
    // A caption saved in place of an empty prompt is not a prompt.
    sourcePrompt: sourcePrompt && isReferenceCaption(sourcePrompt) ? "" : sourcePrompt,
    enhanced: value.enhanced === true ? true : undefined,
    recipe: normalizeRecipe(value.recipe),
    characterSrcs: characterSrcs.slice(0, 3),
    backgroundSrc: RENDER_SRC.test(backgroundSrc) ? backgroundSrc : undefined,
    referenceSrc: RENDER_SRC.test(referenceSrc) ? referenceSrc : undefined,
    referenceSrcs,
    canvasSrc: RENDER_SRC.test(canvasSrc) ? canvasSrc : undefined,
    media: isVideoSrc(src) ? "video" : "image",
    seconds: isVideoSrc(src) ? Math.max(1, Math.min(60, Math.round(toNumber(value.seconds, 0)))) : undefined,
    style: typeof value.style === "string" ? value.style.slice(0, 32) : "none",
    model: typeof value.model === "string" ? value.model.slice(0, 64) : "",
    x: Math.round(toNumber(value.x)),
    y: Math.round(toNumber(value.y)),
    createdAt: toTime(value.createdAt),
  };
}

function normalizeMessage(raw: unknown): Message | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const role = value.role === "assistant" ? "assistant" : value.role === "user" ? "user" : undefined;
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (!role || !text) return undefined;

  return {
    id: typeof value.id === "string" && value.id ? value.id.slice(0, 64) : crypto.randomUUID(),
    role,
    text: text.slice(0, 4000),
    createdAt: toTime(value.createdAt),
  };
}

/** Asset ids are prefixed by where the file came from. */
const ASSET_ID = /^(?:upload|render):[a-z0-9-]{1,64}$/i;

function normalizeAsset(raw: unknown): ProjectAsset | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const src = typeof value.src === "string" ? value.src : "";
  if (!ASSET_SRC.test(src)) return undefined;

  // The extension is the truth here: it is what the store serves the file as,
  // so a mislabelled `kind` cannot turn a clip into a still.
  const kind = assetKindFrom({ name: src });
  if (!kind) return undefined;

  const name = typeof value.name === "string" ? value.name.replace(/\s+/g, " ").trim() : "";
  const seconds = kind !== "image" ? Math.round(toNumber(value.seconds, 0)) : 0;

  return {
    id: typeof value.id === "string" && ASSET_ID.test(value.id) ? value.id.slice(0, 72) : `upload:${crypto.randomUUID()}`,
    kind,
    name: (name || src.split("/").pop() || "Upload").slice(0, 120),
    src,
    createdAt: toTime(value.createdAt),
    ...(seconds > 0 ? { seconds: Math.min(600, seconds) } : {}),
  };
}

/** A project read off disk is untrusted input, so everything is re-validated. */
export function normalizeProject(raw: unknown): Project | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !isProjectId(value.id)) return undefined;

  const createdAt = toTime(value.createdAt);
  const frames = Array.isArray(value.frames)
    ? value.frames
        .map(normalizeFrame)
        .filter((frame): frame is Frame => Boolean(frame))
        .slice(0, MAX_FRAMES)
    : [];
  const messages = Array.isArray(value.messages)
    ? value.messages
        .map(normalizeMessage)
        .filter((message): message is Message => Boolean(message))
        .slice(-MAX_MESSAGES)
    : [];

  // Newest first, one entry per file, so a repeated save cannot pile up copies.
  const assets = Array.isArray(value.assets)
    ? value.assets
        .map(normalizeAsset)
        .filter((asset): asset is ProjectAsset => Boolean(asset))
        .sort((left, right) => right.createdAt - left.createdAt)
        .filter((asset, index, list) => list.findIndex((item) => item.id === asset.id) === index)
        .slice(0, MAX_UPLOADS)
    : [];
  const saved = Array.isArray(value.saved)
    ? value.saved.filter((id): id is string => typeof id === "string" && ASSET_ID.test(id)).slice(0, 200)
    : [];

  return {
    id: value.id,
    name: normalizeName(typeof value.name === "string" ? value.name : ""),
    createdAt,
    updatedAt: toTime(value.updatedAt, createdAt),
    frames,
    messages,
    assets,
    saved,
  };
}

/**
 * Where the next frame goes: the first free slot in a left-to-right grid.
 *
 * A slot is taken when a frame's rect *overlaps* it, not only when the
 * coordinates match exactly. Frames get dragged off the grid, and an exact
 * match would hand a new render the same space one is already sitting in.
 * Pending renders pass their reserved slots in the same way, so two in flight
 * at once cannot pick the same one.
 */
export function nextPosition(frames: readonly { x: number; y: number }[], size = FRAME_SIZE) {
  const step = size + FRAME_GAP;
  const overlapping = (x: number, y: number) =>
    frames.some((frame) => Math.abs(frame.x - x) < size && Math.abs(frame.y - y) < size);

  for (let slot = 0; slot < MAX_FRAMES * 4; slot += 1) {
    const x = (slot % GRID_COLUMNS) * step;
    const y = Math.floor(slot / GRID_COLUMNS) * step;
    if (!overlapping(x, y)) return { x, y };
  }
  return { x: 0, y: 0 };
}

export function createProject(name: string, now = Date.now()): Project {
  return {
    id: crypto.randomUUID(),
    name: normalizeName(name),
    createdAt: now,
    updatedAt: now,
    frames: [],
    messages: [],
    assets: [],
    saved: [],
  };
}

export function summarize(project: Project): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    count: project.frames.length,
    preview: project.frames[0]?.src,
  };
}

/** Total runtime of every clip on the canvas, in seconds. Stills contribute nothing. */
export function clipSeconds(frames: Frame[]) {
  return frames.reduce((total, frame) => total + (isVideoSrc(frame.src) ? (frame.seconds ?? 0) : 0), 0);
}

/** Bounding box of all frames, used to fit the view. */
export function frameBounds(frames: Frame[], size = FRAME_SIZE) {
  if (frames.length === 0) return { x: 0, y: 0, width: size, height: size };
  const left = Math.min(...frames.map((frame) => frame.x));
  const top = Math.min(...frames.map((frame) => frame.y));
  const right = Math.max(...frames.map((frame) => frame.x + size));
  const bottom = Math.max(...frames.map((frame) => frame.y + size));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function relativeTime(timestamp: number, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
