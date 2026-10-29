import assert from "node:assert/strict";
import test from "node:test";
import { BRAIN_OPTIONS, DEFAULT_BRAIN, resolveBrain } from "../lib/brain.ts";
import { MAX_REFERENCE_PIXELS, fitWithinPixels } from "../lib/client-image.ts";

test("every offered model has an adapter and a unique id", () => {
  const ids = BRAIN_OPTIONS.map((option) => option.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes(DEFAULT_BRAIN));

  for (const option of BRAIN_OPTIONS) {
    assert.ok(["anthropic", "openai", "vertexai"].includes(option.provider), option.id);
    assert.equal(option.id.split("/")[0], option.provider);
    assert.ok(option.label.length > 0 && option.note.length > 0);
  }
});

test("an empty request falls back to the configured default", () => {
  assert.equal(resolveBrain(""), DEFAULT_BRAIN);
  assert.equal(resolveBrain(undefined), DEFAULT_BRAIN);
  assert.equal(resolveBrain("", "openai/gpt-5-mini"), "openai/gpt-5-mini");
});

test("allowlisted models pass through", () => {
  for (const option of BRAIN_OPTIONS) {
    assert.equal(resolveBrain(option.id), option.id);
  }
});

test("unknown or unsupported models are refused", () => {
  assert.equal(resolveBrain("google/gemini-3.1-flash"), undefined);
  assert.equal(resolveBrain("anthropic/not-a-model"), undefined);
  assert.equal(resolveBrain("openai"), undefined);
  assert.equal(resolveBrain("../../etc/passwd"), undefined);
});

test("references are capped at one megapixel of total pixels", () => {
  assert.equal(MAX_REFERENCE_PIXELS, 1_000_000);

  const square = fitWithinPixels(2048, 2048);
  assert.deepEqual(square, { width: 1000, height: 1000 });
  assert.ok(square.width * square.height <= MAX_REFERENCE_PIXELS);

  const wide = fitWithinPixels(4000, 2250);
  assert.ok(wide.width * wide.height <= MAX_REFERENCE_PIXELS);
  assert.ok(Math.abs(wide.width / wide.height - 4000 / 2250) < 0.01);
});

test("small references keep their size", () => {
  assert.deepEqual(fitWithinPixels(512, 512), { width: 512, height: 512 });
  assert.deepEqual(fitWithinPixels(800, 400), { width: 800, height: 400 });
});

test("degenerate dimensions never produce a zero-pixel canvas", () => {
  assert.deepEqual(fitWithinPixels(0, 0), { width: 1, height: 1 });
  assert.ok(fitWithinPixels(1, 100000).height > 0);
});
