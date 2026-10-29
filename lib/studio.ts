/**
 * The studio plan: what the chat is allowed to do to the panel.
 *
 * The chat can open any tab and preset any control, but it can never render.
 * That is enforced in two places: `/api/harness` answers a chat turn before any
 * image or video call, and the component only writes state when it applies a
 * plan. A plan is therefore a description of the panel, not a job.
 *
 * The model writes JSON, which is untrusted input twice over (a wrong value is
 * a wasted click, and a hallucinated id would select nothing), so every field
 * is read through the same helpers the pickers use and clamped into a set the
 * provider actually accepts.
 */

import {
  DEFAULT_TOOL,
  IMAGE_RATIOS,
  IMAGE_RESOLUTIONS,
  MAX_PROMPT,
  TOOLS,
  clampImageBatch,
  findImageRatio,
  findImageResolution,
  findImageTool,
  imageRatioLabel,
} from "./harness.ts";
import {
  DEFAULT_VIDEO_MODEL,
  MAX_DURATION,
  MIN_DURATION,
  VIDEO_MODELS,
  VIDEO_MODES,
  VIDEO_RATIOS,
  VIDEO_RESOLUTIONS,
  clampDuration,
  findVideoModel,
  findVideoRatio,
  findVideoResolution,
  lockedByMode,
  videoModeLabel,
  videoRatioLabel,
  videoResolutionLabel,
  type VideoMode,
} from "./video.ts";

/** The tabs the panel can be sent to. */
export const STUDIO_TABS = ["create", "video", "chat", "assets"] as const;
export type StudioTab = (typeof STUDIO_TABS)[number];

export function isStudioTab(value: unknown): value is StudioTab {
  return typeof value === "string" && (STUDIO_TABS as readonly string[]).includes(value);
}

/** The tab names as the panel writes them. */
const TAB_LABELS: Record<StudioTab, string> = {
  create: "Create",
  video: "Video",
  chat: "Chat",
  assets: "Assets",
};

/**
 * A panel setup the chat asked for.
 *
 * Every field but `tab` is optional, and an absent field means "leave what the
 * person already has": the plan is a patch, not a reset.
 */
export type StudioPlan = {
  tab: StudioTab;
  prompt?: string;
  /** Create: the image tool, `bfl/flux-3-image` or `local/flux-3-image`. */
  image?: string;
  /** Create: the Edit switch, which edits a canvas image instead of drawing. */
  edit?: boolean;
  /** Create and video: an aspect ratio id. */
  ratio?: string;
  /** Create and video: an output size id. */
  resolution?: string;
  /** Create: images per press, 1 to 4. */
  batch?: number;
  /** Video: the clip model id. */
  video?: string;
  /** Video: `free`, `audio` or `video`. */
  mode?: VideoMode;
  /** Video: clip length in seconds. */
  seconds?: number;
};

/** What the brain decided to do with one chat turn. */
export type StudioAction =
  | { action: "answer"; answer: string }
  | { action: "open"; plan: StudioPlan };

/** The panel as the chat sees it, so "make it bigger" has something to mean. */
export type StudioState = {
  tab?: string;
  create?: {
    prompt?: string;
    image?: string;
    edit?: boolean;
    ratio?: string;
    resolution?: string;
    batch?: number;
  };
  video?: {
    prompt?: string;
    video?: string;
    mode?: string;
    ratio?: string;
    resolution?: string;
    seconds?: number;
  };
  frames?: number;
};

const IDS = {
  imageRatios: IMAGE_RATIOS.map((ratio) => ratio.id).join(", "),
  imageSizes: IMAGE_RESOLUTIONS.map((option) => `${option.id} (${option.label})`).join(", "),
  imageTools: TOOLS.map((tool) => `${tool.id} (${tool.label})`).join(", "),
  videoRatios: VIDEO_RATIOS.map((ratio) => ratio.id).join(", "),
  videoSizes: VIDEO_RESOLUTIONS.map((option) => `${option.id} (${option.label})`).join(", "),
  videoModels: VIDEO_MODELS.map((model) => `${model.id} (${model.label})`).join(", "),
  videoModes: VIDEO_MODES.map((mode) => `${mode.id} (${mode.label})`).join(", "),
};

/** The chat's instructions: app knowledge, the plan schema, and the hard limits. */
export const STUDIO_SYSTEM_PROMPT = `You are the studio assistant inside Comfy Cinematic, a small image and video studio.

You have two jobs:
- Answer the message directly, conversationally, in one to three sentences. You are a capable general assistant: answer general knowledge questions properly, using what you know.
- Or drive the studio's panel: open a tab and preset its controls so the person only has to press the button.

What you must never do:
- Never render, generate, edit, save, delete or download anything. You have no Generate button and no render model behind one.
- Never claim a picture or a clip exists, was made, was saved, or is on its way. A preset is the most you can do.
- Never say you sent a request. Say what you set up, then tell the person to press Generate themselves.

The studio:
- Create tab: stills with FLUX 3. Aspect ratio is one of ${IDS.imageRatios}. Size is one of ${IDS.imageSizes}. Batch is 1 to 4 images per press. The Edit switch edits a canvas image instead of drawing a new one, and then the shape follows the canvas.
- Image models: ${IDS.imageTools}. Router renders cost Comfy credits; local renders are free.
- Video tab: clips with MiniMax H3. Model is one of ${IDS.videoModels}. Mode is one of ${IDS.videoModes}; audio and video modes need a reference file the person has to attach, so mention that, and in Video Reference mode the panel can continue the attached clip instead of replacing it. Free mode can also take a first or last frame the person drops into the panel's In and Out slots, which starts or ends the clip from that still; that works on Router and on the local model alike. Aspect ratio is one of ${IDS.videoRatios}. Size is one of ${IDS.videoSizes}. Length is ${MIN_DURATION} to ${MAX_DURATION} seconds. A clip render takes minutes, and the local model renders for free.
- Assets tab: every result and upload in the project.
- Chat tab: this conversation.

When the person asks for a picture or a clip, open the right tab with a vivid, self-contained prompt and the settings their words imply. "Portrait" means a portrait ratio, "4K" means the 4k size, "four of them" means batch 4, "short clip" means the shortest length the model allows. Set only the fields they asked for or clearly implied, and leave the rest out.
When they ask what you can do or what the app does, answer instead of opening a tab.
When they ask to change a setting, open that tab with the field set.
You cannot attach images, audio or video files yourself. When a render needs one, say which slot it goes in (a reference slot, the In or Out frame slot, or the mode's file picker) and let the person attach it.
The panel state is given to you before the message; use it to resolve "bigger", "even shorter" and the like.

Reply with ONLY one JSON object, with no code fence and no prose around it.
To answer: {"action":"answer","answer":"..."}
To drive the Create panel: {"action":"open","tab":"create","prompt":"...","image":"<model id>","edit":false,"ratio":"<ratio id>","resolution":"<size id>","batch":2}
To drive the Video panel: {"action":"open","tab":"video","prompt":"...","video":"<model id>","mode":"<mode id>","ratio":"<ratio id>","resolution":"<size id>","seconds":5}
To only open a tab: {"action":"open","tab":"assets"}
Include only the fields you want to set. There is no field that starts a render.
Write plain sentences. Do not use em dashes.`;

function textOf(raw: object, ...keys: string[]) {
  for (const key of keys) {
    const value = Reflect.get(raw, key);
    if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim();
  }
  return undefined;
}

function numberValue(raw: object, ...keys: string[]) {
  for (const key of keys) {
    const value = Reflect.get(raw, key);
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** A mode id or its label, so "Audio Reference" from a chatty model still lands. */
function findVideoMode(value: string | undefined): VideoMode | undefined {
  if (!value) return undefined;
  const wanted = value.trim().toLowerCase();
  return VIDEO_MODES.find((mode) => mode.id === wanted || mode.label.toLowerCase() === wanted)?.id;
}

/** The tab a plan names, or the one its fields imply when the model forgot it. */
function planTab(raw: object): StudioTab | undefined {
  const named = Reflect.get(raw, "tab");
  if (isStudioTab(named)) return named;

  if (Reflect.get(raw, "video") !== undefined || Reflect.get(raw, "mode") !== undefined) return "video";
  if (
    Reflect.get(raw, "seconds") !== undefined ||
    Reflect.get(raw, "duration") !== undefined
  ) {
    return "video";
  }
  if (
    Reflect.get(raw, "image") !== undefined ||
    Reflect.get(raw, "batch") !== undefined ||
    Reflect.get(raw, "edit") !== undefined
  ) {
    return "create";
  }
  if (textOf(raw, "prompt", "image_prompt", "video_prompt")) return "create";
  return undefined;
}

/**
 * Read a plan out of one untrusted object.
 *
 * The order matters: the tool or model is resolved first, because it decides
 * which ratios, sizes and batches are legal for the fields that follow.
 */
export function planFromRaw(raw: unknown): StudioPlan | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const tab = planTab(raw);
  if (!tab) return undefined;

  const plan: StudioPlan = { tab };
  const prompt = textOf(raw, "prompt", "image_prompt", "video_prompt");
  if (prompt) plan.prompt = prompt.slice(0, MAX_PROMPT);

  if (tab === "create") {
    const image = textOf(raw, "image", "image_model");
    if (image && findImageTool(image)) plan.image = image;
    const tool = (plan.image ? findImageTool(plan.image) : undefined) ?? DEFAULT_TOOL;

    if (typeof Reflect.get(raw, "edit") === "boolean") plan.edit = Reflect.get(raw, "edit");

    const ratio = textOf(raw, "ratio", "aspect_ratio");
    if (ratio) plan.ratio = findImageRatio(ratio, tool.aspectRatio, tool.ratios);

    const resolution = textOf(raw, "resolution", "size");
    if (resolution) plan.resolution = findImageResolution(resolution, tool.resolution, tool.resolutions);

    const batch = numberValue(raw, "batch", "count", "images");
    if (batch !== undefined) plan.batch = clampImageBatch(batch, tool.maxBatch);

    // With Edit on, the canvas image decides the shape and the ratio chip is
    // locked, so a planned ratio would be a lie about what the panel shows.
    if (plan.edit) delete plan.ratio;
  }

  if (tab === "video") {
    const video = textOf(raw, "video", "video_model", "model");
    if (video && findVideoModel(video)) plan.video = video;
    const model = (plan.video ? findVideoModel(plan.video) : undefined) ?? DEFAULT_VIDEO_MODEL;

    const mode = findVideoMode(textOf(raw, "mode"));
    if (mode && model.modes.includes(mode)) plan.mode = mode;

    const ratio = textOf(raw, "ratio", "aspect_ratio");
    if (ratio) plan.ratio = findVideoRatio(ratio, model.ratio, model.ratios).id;

    const resolution = textOf(raw, "resolution", "size");
    if (resolution) plan.resolution = findVideoResolution(resolution, model.resolution, model.resolutions);

    const seconds = numberValue(raw, "seconds", "duration", "length");
    if (seconds !== undefined) plan.seconds = clampDuration(seconds, model);

    // A reference mode owns the shape and the length, so the picker disables
    // those chips. Dropping the fields keeps the plan honest about what the
    // panel will actually show.
    if (plan.mode) {
      const locked = lockedByMode(plan.mode);
      if (locked.ratio) delete plan.ratio;
      if (locked.duration) delete plan.seconds;
    }
  }

  return plan;
}

/**
 * Parse the brain's reply into an action.
 *
 * A fenced or chatty reply is accepted, and the older `intent` shape is folded
 * in so a model that ignores the new schema still does something sensible.
 */
export function parseStudioAction(text: string): StudioAction | undefined {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;

  const action = Reflect.get(raw, "action");
  const intent = Reflect.get(raw, "intent");

  if (action === "answer" || (action === undefined && intent === "answer")) {
    const answer = textOf(raw, "answer", "reply");
    return answer ? { action: "answer", answer } : undefined;
  }

  if (action === "open" || action === undefined) {
    const plan = planFromRaw(raw);
    if (plan) return { action: "open", plan };
  }

  return undefined;
}

/** A preset the local router can build without a model call. */
export function planFromPrompt(text: string): StudioPlan | undefined {
  const prompt = text.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT);
  return prompt.length > 1 ? { tab: "create", prompt } : undefined;
}

/** `a, b and c`, without a stray "and" for one item. */
function listed(values: string[]) {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

/**
 * The chat's confirmation, built from the validated plan.
 *
 * Written on the server rather than by the model so it cannot claim a render
 * that never happened, and so the labels match the chips the person sees.
 */
export function describePlan(plan: StudioPlan) {
  const lines: string[] = [];

  if (plan.tab === "create") {
    const tool = (plan.image ? findImageTool(plan.image) : undefined) ?? DEFAULT_TOOL;
    const settings: string[] = [];
    if (plan.image) settings.push(tool.label);
    if (plan.edit !== undefined) settings.push(plan.edit ? "Edit on" : "Edit off");
    if (plan.ratio) settings.push(imageRatioLabel(plan.ratio));
    if (plan.resolution) {
      settings.push(IMAGE_RESOLUTIONS.find((option) => option.id === plan.resolution)?.label ?? plan.resolution);
    }
    if (plan.batch && plan.batch > 1) settings.push(`x${plan.batch}`);

    lines.push(`Opened Create${settings.length ? ` with ${listed(settings)}` : ""}.`);
    if (plan.edit) lines.push("Add the image you want edited first.");
  } else if (plan.tab === "video") {
    const model = (plan.video ? findVideoModel(plan.video) : undefined) ?? DEFAULT_VIDEO_MODEL;
    const settings: string[] = [];
    if (plan.video) settings.push(model.label);
    if (plan.mode) settings.push(videoModeLabel(plan.mode));
    if (plan.ratio) settings.push(videoRatioLabel(plan.ratio));
    if (plan.resolution) {
      const size = VIDEO_RESOLUTIONS.find((option) => option.id === plan.resolution);
      settings.push(size?.label ?? plan.resolution);
    }
    if (plan.seconds) settings.push(`${plan.seconds}s`);

    lines.push(`Opened Video${settings.length ? ` with ${listed(settings)}` : ""}.`);
    if (plan.mode && plan.mode !== "free") {
      lines.push("That mode needs a reference file attached before it can run.");
    }
  } else if (plan.tab === "assets") {
    lines.push("Opened Assets.");
  } else {
    lines.push("Opened Chat.");
  }

  if (plan.prompt) lines.push(`The prompt is ready: "${plan.prompt}".`);
  lines.push("Nothing was generated. Press the button when you are ready.");

  return lines.join(" ");
}

/**
 * The panel as context for the brain.
 *
 * Both generators are described even though only one is on top, because the
 * chat usually runs from its own tab: without this, "make the clip longer"
 * would have nothing to read. Loose on purpose, since it is never executed,
 * and capped so a long prompt cannot crowd out the message.
 */
export function describeStudioState(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const tab = Reflect.get(value, "tab");
  if (!isStudioTab(tab)) return "";

  const parts = [`The panel is open on the ${TAB_LABELS[tab]} tab.`];
  const create = createLine(Reflect.get(value, "create"));
  if (create) parts.push(create);
  const video = videoLine(Reflect.get(value, "video"));
  if (video) parts.push(video);

  const frames = Reflect.get(value, "frames");
  if (typeof frames === "number" && frames > 0) {
    parts.push(`${Math.round(frames)} result${frames === 1 ? "" : "s"} already on the canvas.`);
  }

  return parts.join(" ");
}

/** The prompt box, short enough to sit inside one context line. */
function promptSnippet(box: unknown) {
  if (!box || typeof box !== "object") return undefined;
  const prompt = Reflect.get(box, "prompt");
  if (typeof prompt !== "string" || !prompt.trim()) return undefined;
  return `prompt "${prompt.replace(/\s+/g, " ").trim().slice(0, 300)}"`;
}

function createLine(box: unknown) {
  if (!box || typeof box !== "object") return undefined;
  const parts: string[] = [];
  const prompt = promptSnippet(box);
  if (prompt) parts.push(prompt);

  const image = Reflect.get(box, "image");
  const tool = typeof image === "string" ? findImageTool(image) : undefined;
  if (tool) parts.push(`model ${tool.label}`);
  if (typeof Reflect.get(box, "edit") === "boolean") {
    parts.push(`Edit ${Reflect.get(box, "edit") ? "on" : "off"}`);
  }
  const ratio = Reflect.get(box, "ratio");
  if (typeof ratio === "string") parts.push(`ratio ${imageRatioLabel(ratio)}`);
  const size = IMAGE_RESOLUTIONS.find((option) => option.id === Reflect.get(box, "resolution"));
  if (size) parts.push(`size ${size.label}`);
  const batch = Reflect.get(box, "batch");
  if (typeof batch === "number" && Number.isFinite(batch)) parts.push(`batch ${batch}`);

  return parts.length ? `Create (stills): ${parts.join(", ")}.` : undefined;
}

function videoLine(box: unknown) {
  if (!box || typeof box !== "object") return undefined;
  const parts: string[] = [];
  const prompt = promptSnippet(box);
  if (prompt) parts.push(prompt);

  const video = Reflect.get(box, "video");
  const model = typeof video === "string" ? findVideoModel(video) : undefined;
  if (model) parts.push(`model ${model.label}`);
  const mode = findVideoMode(
    typeof Reflect.get(box, "mode") === "string" ? (Reflect.get(box, "mode") as string) : undefined,
  );
  if (mode) parts.push(`${videoModeLabel(mode)} mode`);
  const ratio = Reflect.get(box, "ratio");
  if (typeof ratio === "string") parts.push(`ratio ${videoRatioLabel(ratio)}`);
  const size = VIDEO_RESOLUTIONS.find((option) => option.id === Reflect.get(box, "resolution"));
  if (size) parts.push(`size ${videoResolutionLabel(size.id)}`);
  const seconds = Reflect.get(box, "seconds");
  if (typeof seconds === "number" && Number.isFinite(seconds)) parts.push(`${Math.round(seconds)}s`);

  return parts.length ? `Video (clips): ${parts.join(", ")}.` : undefined;
}
