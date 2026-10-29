/**
 * The in-house harness.
 *
 * One prompt goes in. The harness decides whether it is a question it can
 * answer, or a description that needs a tool. Two tools are registered —
 * FLUX 3 on Router and the same stack on local ComfyUI, both on the same
 * sixteen ratios, five resolution tiers and four-image batches — so the
 * interesting part is the decision, and the decision is deliberately
 * deterministic and testable.
 *
 * Adding a tool means adding it to `TOOLS` and teaching `routePrompt` when to
 * pick it. Nothing in the UI assumes a single tool; it renders whatever the
 * harness returns.
 */

export const MAX_PROMPT = 900;

/**
 * Where a still is rendered.
 *
 * `router` posts a model request to Comfy Router. `local` runs an API-format
 * graph on the ComfyUI that `COMFY_BASE_URL` points at, through the Comfy SDK
 * — no credits, but the machine does the work.
 */
export type ImageProvider = "router" | "local";

/** FLUX 3's output size classes, smallest first. */
export type ImageResolution = "768sq" | "1k" | "1.5k" | "2k" | "4k";

export type ImageRatio = { id: string; label: string; w: number; h: number };

/**
 * The sixteen aspect ratios the FLUX 3 schema accepts.
 *
 * Grouped landscape → square → portrait, with `auto` last. `auto` follows the
 * first reference image on Router; a local graph has no references, so it
 * resolves to 1:1 there.
 */
export const IMAGE_RATIOS: ImageRatio[] = [
  { id: "21:9", label: "21:9", w: 21, h: 9 },
  { id: "2:1", label: "2:1", w: 2, h: 1 },
  { id: "16:9", label: "16:9", w: 16, h: 9 },
  { id: "3:2", label: "3:2", w: 3, h: 2 },
  { id: "7:5", label: "7:5", w: 7, h: 5 },
  { id: "4:3", label: "4:3", w: 4, h: 3 },
  { id: "5:4", label: "5:4", w: 5, h: 4 },
  { id: "1:1", label: "1:1", w: 1, h: 1 },
  { id: "4:5", label: "4:5", w: 4, h: 5 },
  { id: "3:4", label: "3:4", w: 3, h: 4 },
  { id: "5:7", label: "5:7", w: 5, h: 7 },
  { id: "2:3", label: "2:3", w: 2, h: 3 },
  { id: "9:16", label: "9:16", w: 9, h: 16 },
  { id: "1:2", label: "1:2", w: 1, h: 2 },
  { id: "9:21", label: "9:21", w: 9, h: 21 },
  { id: "auto", label: "Auto", w: 0, h: 0 },
];

/** The five output size classes FLUX 3 accepts. */
export const IMAGE_RESOLUTIONS: { id: ImageResolution; label: string }[] = [
  { id: "768sq", label: "0.75K" },
  { id: "1k", label: "1K" },
  { id: "1.5k", label: "1.5K" },
  { id: "2k", label: "2K" },
  { id: "4k", label: "4K" },
];

/** One press may ask for up to four images. */
export const MAX_IMAGE_BATCH = 4;
export const DEFAULT_IMAGE_BATCH = 1;

/** A still can draw from up to four reference images. */
export const MAX_IMAGE_REFERENCES = 4;

/**
 * ComfyUI's refusal when a checkpoint is not installed on the target.
 *
 * It reads `Value not in list: unet_name: 'x' not in ['a', 'b']`, which is the
 * one render error the app can act on: the fix is a name in the model gear, so
 * the panel opens that dialog with the target's real list already fetched.
 * A long list is abbreviated as `not in (list of length 23)`, so both the bare
 * list and the parenthesised count count as the same refusal.
 */
export function isMissingModelError(message: string) {
  return /value not in list/i.test(message) || /\bnot in\s*[\[(]/i.test(message);
}

/** The shapes and size classes a fresh render starts on. */
export const DEFAULT_IMAGE_RATIO = "1:1";
export const DEFAULT_IMAGE_RESOLUTION: ImageResolution = "1k";

export type Tool = {
  id: string;
  label: string;
  /** Router model id, or the local graph's own id. */
  model: string;
  /** The shape a typed subject starts on. */
  aspectRatio: string;
  /** The size class a render starts on. */
  resolution: ImageResolution;
  /** The shapes this entry accepts. */
  ratios: string[];
  /** The sizes this entry may be asked for, smallest first. */
  resolutions: ImageResolution[];
  /** Most images one press may ask for. */
  maxBatch: number;
  kind: "image";
  provider: ImageProvider;
  note: string;
  /** False when the tool takes a prompt and nothing else. */
  references?: boolean;
};

/**
 * The registered image tools: the same FLUX 3 render twice.
 *
 * `TOOLS[0]` is the default the deterministic router picks, so adding an entry
 * after it never changes what a typed subject gets.
 */
export const TOOLS: Tool[] = [
  {
    id: "bfl/flux-3-image",
    label: "FLUX 3",
    model: "bfl/flux-3-image",
    aspectRatio: DEFAULT_IMAGE_RATIO,
    resolution: DEFAULT_IMAGE_RESOLUTION,
    ratios: IMAGE_RATIOS.map((ratio) => ratio.id),
    resolutions: IMAGE_RESOLUTIONS.map((option) => option.id),
    maxBatch: MAX_IMAGE_BATCH,
    kind: "image",
    provider: "router",
    note: "Black Forest Labs' FLUX 3 through Comfy Router: sixteen ratios, 0.75K to 4K, up to four images per press.",
  },
  {
    id: "local/flux-3-image",
    label: "FLUX 3 Local",
    model: "local/flux-3-image",
    aspectRatio: DEFAULT_IMAGE_RATIO,
    resolution: DEFAULT_IMAGE_RESOLUTION,
    ratios: IMAGE_RATIOS.map((ratio) => ratio.id),
    resolutions: IMAGE_RESOLUTIONS.map((option) => option.id),
    maxBatch: MAX_IMAGE_BATCH,
    kind: "image",
    provider: "local",
    note: "The same FLUX 3 stack on your own ComfyUI or a Comfy deployment, through the Comfy SDK.",
  },
];

export const DEFAULT_TOOL = TOOLS[0]!;

/** The tool a model id names, or undefined when the picker sent nothing known. */
export function findImageTool(id: string) {
  return TOOLS.find((tool) => tool.id === id);
}

/** True when this tool renders on the local ComfyUI instead of Router. */
export function isLocalImageTool(tool: Tool) {
  return tool.provider === "local";
}

/** A known ratio, else `fallback`; `allowed` keeps the answer inside one tool's set. */
export function findImageRatio(
  id: unknown,
  fallback = DEFAULT_IMAGE_RATIO,
  allowed?: readonly string[],
): string {
  const known = (value: unknown) => IMAGE_RATIOS.find((ratio) => ratio.id === value)?.id;
  const fallbackRatio = known(fallback) ?? DEFAULT_IMAGE_RATIO;
  const wanted = known(id) ?? fallbackRatio;
  if (!allowed || allowed.includes(wanted)) return wanted;
  if (allowed.includes(fallbackRatio)) return fallbackRatio;
  return allowed.find((value) => Boolean(known(value))) ?? fallbackRatio;
}

/** The shapes one tool accepts, for its picker. */
export function imageRatioOptions(tool: Tool) {
  return IMAGE_RATIOS.filter((ratio) => tool.ratios.includes(ratio.id));
}

/** A known size class, else the fallback — never something the provider cannot take. */
export function findImageResolution(
  value: unknown,
  fallback: ImageResolution = DEFAULT_IMAGE_RESOLUTION,
  allowed?: readonly ImageResolution[],
): ImageResolution {
  const wanted = typeof value === "string" ? value.trim().toLowerCase() : "";
  const match = IMAGE_RESOLUTIONS.find((option) => option.id === wanted)?.id ?? fallback;
  if (!allowed || allowed.includes(match)) return match;
  if (allowed.includes(fallback)) return fallback;
  return allowed[0] ?? fallback;
}

/** The sizes one tool may be asked for, for its picker. */
export function imageResolutionOptions(tool: Tool) {
  return IMAGE_RESOLUTIONS.filter((option) => tool.resolutions.includes(option.id));
}

/** Keep a requested batch inside 1…max, whole. */
export function clampImageBatch(value: unknown, max = MAX_IMAGE_BATCH): number {
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw)) return DEFAULT_IMAGE_BATCH;
  return Math.min(Math.max(1, Math.round(max)), Math.max(1, Math.round(raw)));
}

/** Every batch count one tool may be asked for. */
export function imageBatchOptions(tool: Tool) {
  return Array.from({ length: Math.max(1, tool.maxBatch) }, (_, index) => index + 1);
}

/** A ratio's label, or the id itself when a stored recipe names one this build dropped. */
export function imageRatioLabel(id: string) {
  return IMAGE_RATIOS.find((ratio) => ratio.id === id)?.label ?? id;
}

export function imageResolutionLabel(id: ImageResolution) {
  return IMAGE_RESOLUTIONS.find((option) => option.id === id)?.label ?? id;
}

/**
 * Defaults for the local FLUX 3 workflow. The model picker's gear writes over
 * these; they are only what a fresh install starts from.
 */
export const LOCAL_IMAGE_DEFAULTS = {
  unet: "flux3-image-klein-int8-convrot0.safetensors",
  clip: "qwen3vl_4b_fp8_scaled.safetensors",
  steps: 20,
} as const;

export type LocalImageModelConfig = { unet: string; clip: string; steps: number };

/** Fill a partial/unknown config from defaults, clamped to sane values. */
export function localImageModelConfig(value: unknown): LocalImageModelConfig {
  const source = (value ?? {}) as Record<string, unknown>;
  const unet = typeof source.unet === "string" ? source.unet.trim() : "";
  const clip = typeof source.clip === "string" ? source.clip.trim() : "";
  const raw = typeof source.steps === "number" ? source.steps : Number(source.steps);
  const steps = Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.round(raw))) : LOCAL_IMAGE_DEFAULTS.steps;

  return {
    unet: unet || LOCAL_IMAGE_DEFAULTS.unet,
    clip: clip || LOCAL_IMAGE_DEFAULTS.clip,
    steps,
  };
}

export type AnswerDecision = {
  intent: "answer";
  answer: string;
  topic: string;
  reason: string;
};

export type ImageDecision = {
  intent: "image";
  prompt: string;
  tool: Tool;
  reason: string;
};

export type Decision = AnswerDecision | ImageDecision;

const QUESTION_OPENER =
  /^(what|why|how|who|whom|whose|which|when|where|is|are|am|was|were|do|does|did|can|could|would|will|should|shall|may|might|must|have|has|had|tell me|explain|define)\b/i;

const IMAGE_VERB = /\b(draw|paint|illustrate|sketch|render|design)\b/i;

const SMALL_TALK = /^(hi|hello|hey|yo|howdy|good (morning|afternoon|evening)|thanks|thank you|cheers|ok|okay|cool|nice)\b/i;

/** "make me an image of a …" → "a …" */
const COMMAND_PREFIX =
  /^(please\s+)?((can|could|would|will)\s+you\s+)?(draw|paint|illustrate|sketch|render|generate|create|make|design|show|give)\s+(me\s+)?(an?\s+|the\s+)?(image|picture|photo|photograph|poster|logo|wallpaper|illustration|artwork|art|render|scene|mockup)?\s*(of\s+|with\s+)?/i;

export function looksLikeQuestion(input: string) {
  const text = input.trim();
  if (!text) return false;
  if (QUESTION_OPENER.test(text)) return true;
  const words = text.split(/\s+/).length;
  return /\?\s*$/.test(text) && words > 3;
}

export function wantsImage(input: string) {
  const text = input.trim();
  if (!text) return false;
  if (IMAGE_VERB.test(text)) return true;
  return /\b(generate|create|make|design|show|give)\b[^.]{0,40}\b(image|picture|photo|poster|logo|wallpaper|illustration|art|render)\b/i.test(
    text,
  );
}

/** Strip the command wrapper so the model gets a subject, not a request. */
export function cleanImagePrompt(input: string) {
  const original = input.replace(/\s+/g, " ").trim();
  let text = original.replace(COMMAND_PREFIX, "").replace(/[?!.]+$/, "").trim();
  text = text.replace(/^(of|for|with)\s+/i, "").trim();
  if (text.length < 2) text = original.replace(/[?!.]+$/, "").trim();
  if (!text) return original;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

type Topic = { id: string; test: RegExp; answer: string };

const TOPICS: Topic[] = [
  {
    id: "greeting",
    test: /^(hi|hello|hey|yo|howdy|good (morning|afternoon|evening))\b/i,
    answer:
      "Hey. I'm the in-house harness. Ask me about the route, the tool or the render size, or describe an image and I'll send it to FLUX 3.",
  },
  {
    id: "identity",
    test: /\b(who are you|what are you|your name|are you an? (ai|model|agent))\b/i,
    answer:
      "I'm the harness that sits in front of the image tools. I read your prompt, decide whether it needs a tool, and call that tool. FLUX 3 renders stills on Comfy Router or on your local ComfyUI: sixteen ratios, five size classes up to 4K, and batches of one to four. Clips live in the Video tab, on MiniMax H3.",
  },
  {
    id: "routing",
    test: /\b(route|routing|harness|decide|decision|which (tool|model)|how do you (choose|pick|know))\b/i,
    answer:
      "Questions are answered here without touching a model. Anything that reads like a visual subject is rewritten into an image prompt and sent to the selected tool (bfl/flux-3-image through Router, or local/flux-3-image on the ComfyUI in Manage account) at the ratio, size and batch the chips show. Each reply shows which branch ran and why.",
  },
  {
    id: "size",
    test: /\b(size|resolution|ratio|aspect|square|1k|2k|4k|16:9|9:16|wide|tall|landscape|portrait)\b/i,
    answer:
      "Sixteen aspect ratios and five size classes (0.75K, 1K, 1.5K, 2K and 4K), plus batches of one to four. The chips under the prompt are the whole control; both tools accept the same set.",
  },
  {
    id: "continue",
    test: /\b(extend|continuation)\b|\b(continue|extend|lengthen)\b[^.]{0,60}\b(video|clip|movie|film|animation|render)\b/i,
    answer:
      "Open a clip and press Continue: the panel arms a continuation — the clip takes the video-reference slot, the prompt, model and reference stills come back the way the clip was made, and the render starts where the clip stopped, with only its last frames sent as the motion guide. Attaching any clip in Video Reference mode does the same without the button, and a first or last frame in Free mode pins the start or end instead. MiniMax H3 Local renders these free on your own ComfyUI; Router renders cost credits.",
  },
  {
    id: "video",
    test: /\b(video|animate|animation|motion|clip|movie|film|audio|sound)\b/i,
    answer:
      "Clips are their own tab. MiniMax H3 runs on Comfy Router or on your local ComfyUI, at the ratio, size and length the Video panel shows, with optional keyframes, a reference clip or a soundtrack.",
  },
  {
    id: "edit",
    test: /\b(edit|inpaint|outpaint|upscale|img2img|image.to.image|reference|consistent|continuity|lora|finetune|fine-tune)\b/i,
    answer:
      "The Create tab's Edit switch edits the canvas image, and up to four reference images steer a new still. Both run through the same FLUX 3 tools; there is no separate edit model.",
  },
  {
    id: "cost",
    test: /\b(cost|costs|credit|credits|price|pricing|billing|charge|free|paid)\b/i,
    answer:
      "A Router render is billed to the Comfy workspace that owns COMFY_API_KEY, for FLUX 3 stills and MiniMax H3 clips alike. The Local entries run the same models on your own ComfyUI and cost no credits. Answering a question costs nothing because the harness handles it locally.",
  },
  {
    id: "model",
    test: /\b(flux|model|models|tool|tools|engine|provider)\b/i,
    answer:
      "FLUX 3 renders stills: bfl/flux-3-image through Comfy Router, and local/flux-3-image on the ComfyUI in Manage account. Both cover sixteen ratios, five size classes up to 4K, and up to four images per press. MiniMax H3 renders clips from the Video tab.",
  },
  {
    id: "capabilities",
    test: /\b(what can you do|what do you do|what is this|what's this|help|capabilities|how do i use|how does this work|what does this do)\b/i,
    answer:
      "Two jobs. Answer questions about this setup, or turn a description into images: any of sixteen ratios, five size classes up to 4K, and one to four images at a time. Type a question and you get text back; type a subject and you get a render.",
  },
  {
    id: "thanks",
    test: /^(thanks|thank you|cheers|nice|cool|great)\b/i,
    answer: "Anytime.",
  },
];

const FALLBACK =
  "I can only answer questions about this setup right now: the route, the registered tools, the ratios and sizes, batch counts and cost. For anything else, describe an image and I'll render it.";

export const CHARACTER_CLAUSE =
  "The person in the reference image is the character: keep their face, hair, build and wardrobe identical.";

export const CHARACTERS_CLAUSE =
  "The people in the reference images are the characters: keep each face, hair, build and wardrobe identical.";

export const BACKGROUND_CLAUSE =
  "Use the place in the background reference image as the setting: keep its architecture, layout, materials and light direction consistent.";

export const REFERENCE_CLAUSE =
  "Use image 1 as the reference: keep the subject, its appearance and the setting consistent with it.";

/**
 * The reference sentence for one or more images.
 *
 * FLUX 3 addresses references as `image 1`, `image 2`, … so a multi-reference
 * render names the range it was given.
 */
export function referenceClause(count: number) {
  const total = Math.max(0, Math.round(count));
  if (total <= 1) return REFERENCE_CLAUSE;
  return `Use images 1-${total} as references: keep each subject, its appearance and the setting consistent with them.`;
}

export type References = {
  characters?: number;
  background?: boolean;
  reference?: boolean;
  references?: number;
  /** Canvas mode: image 1 is the picture to edit, not a reference. */
  canvas?: boolean;
};

/**
 * The exact string FLUX receives.
 *
 * Subject first so the model leads with it, then the style phrase, then the
 * reference constraints last so they stay in recent context. Characters come
 * before background because identity is the harder thing to preserve.
 */
export function composePrompt(subject: string, phrase: string, refs: References = {}) {
  const trimmed = subject.replace(/\s+/g, " ").trim().replace(/[\s.]+$/, "");
  const parts = [phrase ? `${trimmed}. ${phrase}.` : `${trimmed}.`];
  if (refs.canvas) {
    const total = 1 + (refs.references ?? 0);
    parts.push(
      total > 1
        ? `Image 1 is the image to edit. Images 2-${total} are references: keep each subject, its appearance and the setting consistent with them.`
        : "Image 1 is the image to edit.",
    );
    return parts.join(" ");
  }
  const referenceCount = refs.references ?? (refs.reference ? 1 : 0);
  if (referenceCount > 0) {
    parts.push(referenceClause(referenceCount));
    return parts.join(" ");
  }
  const characters = refs.characters ?? 0;
  if (characters > 0) parts.push(characters > 1 ? CHARACTERS_CLAUSE : CHARACTER_CLAUSE);
  if (refs.background) parts.push(BACKGROUND_CLAUSE);
  return parts.join(" ");
}

/**
 * Which text becomes the image subject.
 *
 * The flavor toggle is a contract, not a hint: when it is off the typed
 * prompt goes through unchanged even though the brain produced a rewrite.
 */
export function pickSubject(
  decision: { intent: "image"; prompt: string },
  sourcePrompt: string,
  enhance: boolean,
) {
  return enhance ? decision.prompt : sourcePrompt;
}

function answerFor(input: string): { answer: string; topic: string } {
  for (const topic of TOPICS) {
    if (topic.test.test(input)) return { answer: topic.answer, topic: topic.id };
  }
  return { answer: FALLBACK, topic: "fallback" };
}

/**
 * The routing decision. Pure: same input, same decision, no network.
 *
 * Order matters. A question about this setup is answered before an image verb
 * is considered ("What size do you render?"), but a question that explicitly
 * asks for a picture still renders ("Can you draw a cat?").
 */
export function routePrompt(input: string): Decision {
  const text = input.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT);
  if (!text) {
    return { intent: "answer", answer: "Send a question or describe an image.", topic: "empty", reason: "Empty prompt." };
  }

  if (looksLikeQuestion(text)) {
    const { answer, topic } = answerFor(text);
    if (topic !== "fallback") {
      return { intent: "answer", answer, topic, reason: `Matched “${topic}”.` };
    }
    if (wantsImage(text)) {
      return imageDecision(text, "A question that explicitly asks for an image, so the render branch wins.");
    }
    return {
      intent: "answer",
      answer,
      topic,
      reason: "A question the local knowledge base does not cover.",
    };
  }

  if (SMALL_TALK.test(text)) {
    const { answer, topic } = answerFor(text);
    return { intent: "answer", answer, topic, reason: `Matched “${topic}”.` };
  }

  return imageDecision(text, "Not a question, so it is treated as a subject.");
}

function imageDecision(text: string, reason: string): ImageDecision {
  return {
    intent: "image",
    prompt: cleanImagePrompt(text),
    tool: DEFAULT_TOOL,
    reason,
  };
}
