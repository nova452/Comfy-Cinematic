import assert from "node:assert/strict";
import test from "node:test";
import { FLAVOR_BRAIN, REFERENCE_BRAIN, REFERENCE_THINKING } from "../lib/brain.ts";
import {
  buildContinuationPrompt,
  buildReferencePrompt,
  buildReferenceRequest,
  dataUriParts,
  mimeOfBase64,
  parseReferenceRewrite,
} from "../lib/reference.ts";

const PNG = `iVBORw0KGgo${"A".repeat(80)}`;
const MP4 = `data:video/mp4;base64,${"B".repeat(80)}`;
const WAV = `data:audio/wav;base64,${"C".repeat(80)}`;

test("a continuation asks for the shot that runs after the clip", () => {
  assert.equal(
    buildContinuationPrompt(5, "  she keeps   walking  "),
    "Create a 5s video prompt that runs after the provided clip.\nExtra details: she keeps walking",
  );
  // Nothing typed is still a continuation: the clip is the whole brief.
  assert.equal(
    buildContinuationPrompt(8, "   "),
    "Create a 8s video prompt that runs after the provided clip.\nExtra details: None.",
  );
});

test("one character against a clip is the canonical swap", () => {
  assert.equal(
    buildReferencePrompt("make it night", { characters: 1, background: false, video: true, audio: false }),
    "make it night\nCharacter swap reference: <image1>\nScene: <video1>",
  );
});

test("an empty prompt states the swap instead of asking for words", () => {
  assert.equal(
    buildReferencePrompt("", { characters: 1, background: false, video: true, audio: false }),
    "Replace a subject with the provided character.\nCharacter swap reference: <image1>\nScene: <video1>",
  );
});

test("two characters and a background get their own sentence", () => {
  assert.equal(
    buildReferencePrompt("   ", { characters: 2, background: true, video: true, audio: false }),
    [
      "Replace subjects with the provided characters and the background with the provided background.",
      "Character swap reference: <image1>",
      "Character2 swap reference: <image2>",
      "Background swap reference: <image3>",
      "Scene: <video1>",
    ].join("\n"),
  );
});

test("anything else lists what is attached, in label order", () => {
  assert.equal(
    buildReferencePrompt("a slow push in", { characters: 2, background: true, video: true, audio: false }),
    [
      "a slow push in",
      "Character swap reference: <image1>",
      "Character2 swap reference: <image2>",
      "Background swap reference: <image3>",
      "Scene: <video1>",
    ].join("\n"),
  );

  assert.equal(
    buildReferencePrompt("follow the beat", { characters: 0, background: false, video: false, audio: true }),
    "follow the beat\nAudio: <audio1>",
  );
});

test("the request carries the stills and the clip inline", () => {
  const body = buildReferenceRequest(
    REFERENCE_BRAIN,
    "make it night",
    { images: [PNG], video: MP4 },
    REFERENCE_THINKING,
  );

  const system = (body.systemInstruction as { parts: { text: string }[] }).parts[0]!.text;
  assert.match(system, /Full-Reference Mode Rewrite Output Format Guide/);

  const parts = (body.contents as { parts: Record<string, unknown>[] }[])[0]!.parts;
  assert.deepEqual(parts[0], { text: "make it night" });
  assert.deepEqual(parts[1], { inlineData: { mimeType: "image/png", data: PNG } });
  assert.deepEqual(parts[2], {
    inlineData: { mimeType: "video/mp4", data: MP4.split(",")[1] },
    mediaProcessing: "AGENTIC",
  });
  assert.equal(parts.length, 3);

  assert.deepEqual(body.generationConfig, {
    temperature: 0.7,
    maxOutputTokens: 4096,
    thinkingConfig: { thinkingLevel: "MEDIUM" },
  });
});

test("audio is sent as a part, without the clip-only flag", () => {
  const body = buildReferenceRequest(REFERENCE_BRAIN, "follow the beat", { audio: WAV }, "high");
  const parts = (body.contents as { parts: Record<string, unknown>[] }[])[0]!.parts;
  assert.deepEqual(parts[1], { inlineData: { mimeType: "audio/wav", data: WAV.split(",")[1] } });
});

test("a model that cannot watch a clip is handed the words alone", () => {
  const body = buildReferenceRequest(FLAVOR_BRAIN, "make it night", { images: [PNG], video: MP4 }, "medium");

  // An Anthropic body: system + messages, and no media parts anywhere.
  assert.match(JSON.stringify(body.system), /Full-Reference Mode Rewrite Output Format Guide/);
  assert.equal(body.contents, undefined);
  assert.equal(JSON.stringify(body).includes(PNG), false);
  assert.deepEqual(body.messages, [{ role: "user", content: "make it night" }]);
});

test("a rewrite is accepted whole, or refused outright", () => {
  const good = [
    "subject_definitions:",
    "<Subject 1> is the young woman in <Picture 1>, with long dark hair.",
    "",
    "summary:",
    "[reference generation] The target video shows <Subject 1> crossing a street.",
  ].join("\n");
  assert.equal(parseReferenceRewrite(good), good);

  // A whole answer wrapped in one fence is unwrapped, not rejected.
  assert.equal(parseReferenceRewrite(`\`\`\`text\n${good}\n\`\`\``), good);

  // Fragments fall back to the typed prompt rather than rendering half a spec.
  assert.equal(parseReferenceRewrite("sure, here you go"), undefined);
  assert.equal(parseReferenceRewrite("subject_definitions: <Subject 1>"), undefined);
});

test("media types are read from the payload itself", () => {
  assert.equal(mimeOfBase64(PNG), "image/png");
  assert.equal(mimeOfBase64("/9j/4AAQSkZJRg"), "image/jpeg");
  assert.equal(mimeOfBase64("UklGRiQAAABXRUJQ"), "image/webp");

  assert.deepEqual(dataUriParts(MP4), { mimeType: "video/mp4", data: "B".repeat(80) });
  assert.deepEqual(dataUriParts("data:AUDIO/MP3;base64,AAAA"), { mimeType: "audio/mp3", data: "AAAA" });
  assert.equal(dataUriParts("https://example.com/clip.mp4"), undefined);
});
