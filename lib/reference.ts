/**
 * The reference rewrite: what a clip is turned into before H3 sees it.
 *
 * Audio and video reference modes cannot hand their clip to H3 — Router's H3
 * schema declares text and image input only — so the clip goes to the one
 * family that can watch it (Gemini, via Vertex), which writes the six-section
 * prompt H3 was trained on. That text is what the render actually uses.
 */

import {
  REFERENCE_BRAIN,
  REFERENCE_THINKING,
  acceptsThinking,
  buildBrainRequest,
  providerOf,
  type ThinkingLevel,
} from "./brain.ts";
import { REFERENCE_SYSTEM_PROMPT } from "./reference-guide.ts";

/** What the panel attached, in the order the labels are numbered. */
export type ReferenceCounts = {
  characters: number;
  background: boolean;
  video: boolean;
  audio: boolean;
};

/**
 * The user turn: the typed idea plus the label of every attached asset.
 *
 * Gemini sees the media inline in this same order, and the guide it is given
 * expects `<imageN>` and `<videoN>` to name them. The two canonical swaps are
 * spelled exactly the way the H3 prompt structure spells them; anything else
 * lists what is attached so nothing arrives unlabelled. An empty prompt is
 * legal here — "replace this person with this character" is the whole brief.
 */
export function buildReferencePrompt(prompt: string, counts: ReferenceCounts) {
  const typed = prompt.replace(/\s+/g, " ").trim();
  const images = counts.characters + (counts.background ? 1 : 0);

  // One character against one clip: the swap this mode exists for.
  if (counts.video && images === 1) {
    return [
      typed || "Replace a subject with the provided character.",
      "Character swap reference: <image1>",
      "Scene: <video1>",
    ].join("\n");
  }

  // Two characters and a background, with nothing typed.
  if (counts.video && !typed && counts.characters === 2 && counts.background) {
    return [
      "Replace subjects with the provided characters and the background with the provided background.",
      "Character swap reference: <image1>",
      "Character2 swap reference: <image2>",
      "Background swap reference: <image3>",
      "Scene: <video1>",
    ].join("\n");
  }

  const lines = [typed || "Rewrite the attached references as one shot."];
  for (let index = 1; index <= counts.characters; index += 1) {
    lines.push(`Character${index === 1 ? "" : index} swap reference: <image${index}>`);
  }
  if (counts.background) lines.push(`Background swap reference: <image${images}>`);
  if (counts.video) lines.push("Scene: <video1>");
  if (counts.audio) lines.push("Audio: <audio1>");
  return lines.join("\n");
}

/**
 * The user turn for a continuation.
 *
 * The prompt model watches the whole clip — it is the only model that can — and
 * writes the shot that runs after it. MiniMax never sees more than the tail, so
 * the text has to carry what came before rather than assuming the model watched
 * it too.
 */
export function buildContinuationPrompt(duration: number, prompt: string) {
  const typed = prompt.replace(/\s+/g, " ").trim();
  return [
    `Create a ${Math.round(duration)}s video prompt that runs after the provided clip.`,
    `Extra details: ${typed || "None."}`,
  ].join("\n");
}

/** The media the rewrite is allowed to look at. */
export type ReferenceMedia = {
  /** Base64 stills, characters first, then the background. */
  images?: string[];
  /** A `data:video/…;base64,…` URI. */
  video?: string;
  /** A `data:audio/…;base64,…` URI. */
  audio?: string;
};

/** `image/png` and friends, sniffed from the first bytes of the payload. */
export function mimeOfBase64(data: string) {
  if (data.startsWith("/9j/")) return "image/jpeg";
  if (data.startsWith("iVBORw0KGgo")) return "image/png";
  if (data.startsWith("UklGR")) return "image/webp";
  if (data.startsWith("R0lGOD")) return "image/gif";
  return "image/jpeg";
}

/** `data:video/mp4;base64,AAAA` → its media type and payload. */
export function dataUriParts(uri: string) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(uri.trim());
  if (!match) return undefined;
  return { mimeType: match[1]!.toLowerCase(), data: match[2]! };
}

/**
 * The request that asks a model to write the rewrite.
 *
 * Gemini takes the media as `inlineData` parts and reads a clip on demand
 * (`mediaProcessing: "AGENTIC"`, supported from 3.7 Flash) instead of sampling
 * every frame. A model that cannot watch video is still called — but with the
 * words alone, which is the most it can honestly do.
 */
export function buildReferenceRequest(
  model: string,
  prompt: string,
  media: ReferenceMedia = {},
  thinking?: ThinkingLevel,
): Record<string, unknown> {
  if (providerOf(model) !== "vertexai") {
    return buildBrainRequest(model, prompt, REFERENCE_SYSTEM_PROMPT, thinking);
  }

  const parts: Record<string, unknown>[] = [{ text: prompt }];
  for (const image of media.images ?? []) {
    parts.push({ inlineData: { mimeType: mimeOfBase64(image), data: image } });
  }
  for (const uri of [media.video, media.audio]) {
    if (!uri) continue;
    const inline = dataUriParts(uri);
    if (!inline) continue;
    parts.push({
      inlineData: inline,
      ...(inline.mimeType.startsWith("video/") ? { mediaProcessing: "AGENTIC" } : {}),
    });
  }

  const level = thinking && acceptsThinking(model) ? thinking.toUpperCase() : undefined;
  return {
    systemInstruction: { parts: [{ text: REFERENCE_SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 4_096,
      ...(level ? { thinkingConfig: { thinkingLevel: level } } : {}),
    },
  };
}

/**
 * Read the six sections out of a reply.
 *
 * The whole answer is the prompt, so the only cleaning is undoing what models
 * like to add: a wrapper fence, a stray preamble line, doubled blank lines.
 * Anything shorter than a real section list is refused, so a failed rewrite
 * falls back to what the user typed instead of rendering a fragment.
 */
export function parseReferenceRewrite(text: string): string | undefined {
  let value = text.trim();
  const fenced = /^```(?:text|markdown)?\n([\s\S]*?)\n```$/i.exec(value);
  if (fenced) value = fenced[1]!.trim();

  const cleaned = value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (cleaned.length < 40) return undefined;
  if (!/subject[_ ]definitions/i.test(cleaned)) return undefined;
  return cleaned;
}

/** The model and level the rewrite will run at, defaults filled in. */
export function referenceDefault() {
  return { brain: REFERENCE_BRAIN, thinking: REFERENCE_THINKING };
}
