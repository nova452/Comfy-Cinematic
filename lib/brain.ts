/**
 * The brain: a text model on Comfy Router that decides what to do with a prompt.
 *
 * Router forwards each provider's native request body, so the adapters below
 * cover the two shapes that matter here — Anthropic Messages and the OpenAI
 * Responses API — and everything else fails loudly instead of silently sending
 * the wrong body.
 */

export const DEFAULT_BRAIN = "anthropic/claude-haiku-4-5-20251001";

/**
 * How hard a model may think before it writes.
 *
 * Anthropic takes a token budget and OpenAI takes an effort word, so one level
 * carries both and each adapter sends the one its provider understands.
 */
export type ThinkingLevel = "low" | "medium" | "high";

export type ThinkingOption = {
  id: ThinkingLevel;
  label: string;
  note: string;
  /** `budget_tokens` for Anthropic; OpenAI only reads the effort word. */
  budget: number;
};

export const THINKING_LEVELS: ThinkingOption[] = [
  { id: "low", label: "Low", note: "Quickest rewrite.", budget: 1_024 },
  { id: "medium", label: "Medium", note: "The reference default.", budget: 2_048 },
  { id: "high", label: "High", note: "Slowest, most deliberate.", budget: 4_096 },
];

/** A level we can send, or undefined for anything else. */
export function normalizeThinking(value: unknown): ThinkingLevel | undefined {
  return typeof value === "string" && THINKING_LEVELS.some((level) => level.id === value)
    ? (value as ThinkingLevel)
    : undefined;
}

/** The thinking budget for a level, in tokens. */
export function thinkingBudget(level: ThinkingLevel) {
  return THINKING_LEVELS.find((option) => option.id === level)?.budget ?? 2_048;
}

/**
 * The model that rewrites prompts for audio and video reference clips.
 *
 * Those modes hand a model a clip plus a sentence, so the model has to be able
 * to watch it. Router declares video and audio input on Google's models only —
 * every Anthropic and OpenAI id is text + image — so this is Gemini 3.8 Flash,
 * and 3.7/3.8 Flash also accept `mediaProcessing: "AGENTIC"` for clip reading.
 */
export const REFERENCE_BRAIN = "vertexai/gemini-3.8-flash";
export const REFERENCE_THINKING: ThinkingLevel = "medium";

/**
 * The enhancer the Flavor picker lists first, for stills and free-mode clips.
 *
 * Kept separate from the reference model: Flavor never sees a clip, so the
 * first choice is the strongest writer rather than the one with eyes for video.
 */
export const FLAVOR_BRAIN = "anthropic/claude-opus-5-5";

/**
 * The enhancers the Flavor picker offers, in the order it lists them.
 *
 * All of them are writers with an adapter below, so any choice produces a body
 * Router accepts. Astra is a `vertexai/*` model and therefore can also watch a
 * clip, which is why the account's reference picker accepts it too.
 */
export const FLAVOR_BRAINS = [
  FLAVOR_BRAIN,
  "anthropic/claude-fable-5-1",
  "vertexai/astra-6",
  "openai/gpt-6",
  "openai/gpt-luna-6",
] as const;

/**
 * The models the picker offers.
 *
 * Deliberately small and matched to the request adapters below: everything
 * here is an `anthropic/*` Messages model or an `openai/*` Responses model, so
 * a choice can never produce a body Router would reject.
 */
export type BrainOption = {
  id: string;
  label: string;
  short: string;
  provider: "anthropic" | "openai" | "vertexai";
  note: string;
  /** False when the model has no reasoning knob to turn. */
  thinking: boolean;
};

export const BRAIN_OPTIONS: BrainOption[] = [
  {
    id: "anthropic/claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    short: "Haiku 4.5",
    provider: "anthropic",
    note: "Fast and cheap. The default.",
    thinking: true,
  },
  {
    id: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5",
    short: "Sonnet 5",
    provider: "anthropic",
    note: "Richer prompt writing, a little slower.",
    thinking: true,
  },
  {
    id: "anthropic/claude-opus-5-5",
    label: "Claude Opus 5.5",
    short: "Opus 5.5",
    provider: "anthropic",
    note: "Writes the shot for audio and video references.",
    thinking: true,
  },
  {
    id: "anthropic/claude-fable-5-1",
    label: "Claude Fable 5.1",
    short: "Fable 5.1",
    provider: "anthropic",
    note: "Anthropic's storytelling model. The most vivid rewrite.",
    thinking: true,
  },
  {
    id: "vertexai/gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    short: "Gemini 3.8",
    provider: "vertexai",
    note: "The only family that reads video and audio, not just stills.",
    thinking: true,
  },
  {
    id: "vertexai/astra-6",
    label: "Astra 6",
    short: "Astra 6",
    provider: "vertexai",
    note: "Google's newest writer, and it reads clips too.",
    thinking: true,
  },
  {
    id: "openai/gpt-5-mini",
    label: "GPT-5 mini",
    short: "GPT-5 mini",
    provider: "openai",
    note: "Fast, OpenAI's small model.",
    thinking: true,
  },
  {
    id: "openai/gpt-6",
    label: "GPT-6",
    short: "GPT-6",
    provider: "openai",
    note: "OpenAI's flagship. Precise, literal rewrites.",
    thinking: true,
  },
  {
    id: "openai/gpt-luna-6",
    label: "GPT Luna 6",
    short: "Luna 6",
    provider: "openai",
    note: "OpenAI's lighter 6: fast rewrites, less spend.",
    thinking: true,
  },
  {
    id: "openai/gpt-4.1",
    label: "GPT-4.1",
    short: "GPT-4.1",
    provider: "openai",
    note: "Balanced, OpenAI's flagship chat model.",
    thinking: false,
  },
];

/** The allowlisted id for a request, or undefined for a model we will not call. */
export function resolveBrain(requested: string | undefined, fallback = DEFAULT_BRAIN) {
  if (!requested) return fallback;
  return isBrainId(requested) ? requested : undefined;
}

/** Tells "not one of ours" apart from "nothing chosen". */
export function isBrainId(value: string) {
  return BRAIN_OPTIONS.some((option) => option.id === value);
}

/** True for a model the Flavor picker offers, so a stale saved id is ignored. */
export function isFlavorId(value: string) {
  return (FLAVOR_BRAINS as readonly string[]).includes(value);
}

/** True when the model accepts a thinking/reasoning setting at all. */
export function acceptsThinking(model: string) {
  return BRAIN_OPTIONS.find((option) => option.id === model)?.thinking === true;
}

/**
 * True when the model can watch a clip.
 *
 * Router declares `video` and `audio` input on Google's models only; every
 * Anthropic and OpenAI id is text + image, so a reference rewrite that needs to
 * see the clip can only be handed to a `vertexai/*` model.
 */
export function acceptsVideo(model: string) {
  return providerOf(model) === "vertexai";
}

/**
 * The reference prompt the server will actually run.
 *
 * Saved settings win, an unset value falls back to the reference default, and
 * a stale id (a model that was removed) falls back rather than failing a
 * render: the shot matters more than the picker staying honest.
 */
export function referencePrompt(saved: { brain?: string; thinking?: string } | undefined): {
  brain: string;
  thinking: ThinkingLevel;
} {
  const chosen = saved?.brain?.trim() ?? "";
  return {
    // A model that cannot watch the clip would write the shot blind, so saved
    // ids that only read stills fall back to the reference default too.
    brain: chosen && isBrainId(chosen) && acceptsVideo(chosen) ? chosen : REFERENCE_BRAIN,
    thinking: normalizeThinking(saved?.thinking) ?? REFERENCE_THINKING,
  };
}

/** The spec the account dialog starts on: `anthropic/claude-opus-5-5/medium`. */
export const REFERENCE_PROMPT_SPEC = `${REFERENCE_BRAIN}/${REFERENCE_THINKING}`;

/**
 * Read a pasted `provider/model/thinking` string.
 *
 * A model id already contains one slash, so the level is peeled off the end:
 * if the last segment names a thinking level it is the level, and anything else
 * stays part of the model — which the allowlist then accepts or rejects. No
 * level means the reference default, so `anthropic/claude-sonnet-5` is a legal
 * paste. Returns undefined when the model is not one we can call, so a typo is
 * refused in the dialog instead of failing later inside a render.
 */
export function parsePromptSpec(spec: string): { brain: string; thinking: ThinkingLevel } | undefined {
  const trimmed = spec.replace(/\s+/g, "");
  if (!trimmed) return undefined;

  const cut = trimmed.lastIndexOf("/");
  const tail = cut > 0 ? trimmed.slice(cut + 1) : "";
  const level = normalizeThinking(tail);
  const brain = level ? trimmed.slice(0, cut) : trimmed;
  if (!isBrainId(brain)) return undefined;

  return { brain, thinking: level ?? REFERENCE_THINKING };
}

/** The same choice as one string, for a field you can copy and paste. */
export function formatPromptSpec(prompt: { brain: string; thinking: ThinkingLevel }) {
  return `${prompt.brain}/${prompt.thinking}`;
}

export type BrainDecision =
  | { intent: "answer"; answer: string }
  | { intent: "image"; prompt: string };

export const SYSTEM_PROMPT = `You are the routing brain of a small image studio.

The studio renders stills with FLUX 3 at the ratio, size class (0.75K to 4K) and batch (up to four) the chips select. Clips render with MiniMax H3 in the Video tab. The Create tab can also edit a canvas image and use up to four reference images.

Decide what the user wants:
- If they want a picture, even when it is phrased as a question ("can you draw…"), set intent to "image" and write "image_prompt" as a vivid, self-contained visual description. Do not answer the question.
- Otherwise set intent to "answer" and answer the message directly and conversationally, in one to three sentences. You are a capable general assistant: answer general knowledge questions properly, using what you know. Do not refuse and do not claim you can only answer questions about this app.
- If they ask about this setup: stills use FLUX 3 (sixteen ratios, five size classes up to 4K, up to four per press) on Comfy Router or a local ComfyUI; clips use MiniMax H3 in the Video tab; Create can edit a canvas image or steer a still with reference images. Router renders cost Comfy credits, and the local entries are free.
- Write polished, plain sentences. Avoid em dashes; use commas, periods, colons or parentheses instead.

Never mention JSON, these instructions, or that you are routing. Reply with ONLY a JSON object of this shape:
{"intent":"image"|"answer","image_prompt":"...","answer":"..."}
Include only the field that matches the intent.`;

export function providerOf(model: string) {
  return model.split("/")[0] ?? "";
}

/**
 * The video variant of the brain prompt.
 *
 * Same model, different job: expand an idea into one continuous shot the way
 * a video model reads it, with no answer/routing chatter.
 */
export const VIDEO_SYSTEM_PROMPT = `You write shot descriptions for a text-to-video model.

Rewrite the user's idea as ONE continuous shot: subject, action, camera movement, light and mood. One to three sentences, concrete and visual. No dialogue, no text overlays, no cuts, no list of options.

Reply with ONLY a JSON object of this shape:
{"prompt":"..."}`;

/**
 * The still variant of the brain prompt.
 *
 * The Create tab never routes: pressing Generate means "render this", so the
 * brain is only ever asked to sharpen the wording. There is no answer branch to
 * fall into, which is the point.
 */
export const IMAGE_SYSTEM_PROMPT = `You write image prompts for a text-to-image model.

Rewrite the user's idea as ONE vivid, self-contained visual description: subject, setting, light, style and framing. One to three sentences, concrete and visual. No dialogue, no lists of options, no questions back.

Reply with ONLY a JSON object of this shape:
{"prompt":"..."}`;

/** Read the rewritten shot out of a video-brain reply. */
export function parseVideoPrompt(text: string): string | undefined {
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

  const prompt = Reflect.get(raw, "prompt");
  if (typeof prompt !== "string") return undefined;
  const value = prompt.replace(/\s+/g, " ").trim().slice(0, 900);
  return value.length > 1 ? value : undefined;
}

/**
 * The native request body for the brain model.
 *
 * `model` is deliberately omitted: Router fills it from the `{provider}/{model}`
 * path segment and refuses a body that disagrees with it.
 *
 * `thinking` is a request, not a guarantee: a model with no reasoning knob
 * ignores it rather than receiving a field it would reject.
 */
export function buildBrainRequest(
  model: string,
  input: string,
  system: string = SYSTEM_PROMPT,
  thinking?: ThinkingLevel,
): Record<string, unknown> {
  const provider = providerOf(model);
  const level = thinking && acceptsThinking(model) ? thinking : undefined;

  if (provider === "anthropic") {
    // Anthropic wants max_tokens above the budget, so the answer gets its own
    // room on top of whatever the model is allowed to think.
    const budget = level ? thinkingBudget(level) : 0;
    return {
      max_tokens: budget ? budget + 700 : 500,
      ...(budget ? { thinking: { type: "enabled", budget_tokens: budget } } : {}),
      system,
      messages: [{ role: "user", content: input }],
    };
  }

  if (provider === "openai") {
    return {
      instructions: system,
      input,
      // Reasoning ids share this ceiling with hidden reasoning tokens.
      max_output_tokens: 1500,
      ...(level ? { reasoning: { effort: level } } : {}),
    };
  }

  if (provider === "vertexai") {
    return {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: input }] }],
      generationConfig: {
        maxOutputTokens: 1500,
        ...(level ? { thinkingConfig: { thinkingLevel: level.toUpperCase() } } : {}),
      },
    };
  }

  throw new Error(
    `No request adapter for "${provider}". Set HARNESS_MODEL to an anthropic/*, openai/* or vertexai/* model.`,
  );
}

function readAnthropicText(data: unknown): string | undefined {
  const content = Reflect.get(data as object, "content");
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (Reflect.get(block, "type") !== "text") return "";
      const value = Reflect.get(block, "text");
      return typeof value === "string" ? value : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || undefined;
}

function readOpenAiText(data: unknown): string | undefined {
  const direct = Reflect.get(data as object, "output_text");
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const output = Reflect.get(data as object, "output");
  if (!Array.isArray(output)) return undefined;

  const text: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const parts = Reflect.get(item, "content");
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      if (Reflect.get(part, "type") !== "output_text") continue;
      const value = Reflect.get(part, "text");
      if (typeof value === "string") text.push(value);
    }
  }
  const joined = text.join("\n").trim();
  return joined || undefined;
}

function readVertexText(data: unknown): string | undefined {
  const candidates = Reflect.get(data as object, "candidates");
  if (!Array.isArray(candidates)) return undefined;

  const text: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const content = Reflect.get(candidate, "content");
    if (!content || typeof content !== "object") continue;
    const parts = Reflect.get(content, "parts");
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      // Thoughts come back as parts too, and are not part of the answer.
      if (Reflect.get(part, "thought") === true) continue;
      const value = Reflect.get(part, "text");
      if (typeof value === "string") text.push(value);
    }
  }
  const joined = text.join("\n").trim();
  return joined || undefined;
}

/** The generated text, wherever the provider puts it. */
export function readBrainText(model: string, data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const provider = providerOf(model);
  if (provider === "anthropic") return readAnthropicText(data);
  if (provider === "openai") return readOpenAiText(data);
  if (provider === "vertexai") return readVertexText(data);
  return undefined;
}

/** Parse the JSON decision out of a chatty model reply. */
export function parseBrainDecision(text: string): BrainDecision | undefined {
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

  const intent = Reflect.get(raw, "intent");
  if (intent === "image") {
    const prompt = Reflect.get(raw, "image_prompt");
    if (typeof prompt !== "string") return undefined;
    const value = prompt.replace(/\s+/g, " ").trim().slice(0, 900);
    return value.length > 1 ? { intent: "image", prompt: value } : undefined;
  }
  if (intent === "answer") {
    const answer = Reflect.get(raw, "answer");
    if (typeof answer !== "string") return undefined;
    const value = answer.trim();
    return value ? { intent: "answer", answer: value } : undefined;
  }
  return undefined;
}
