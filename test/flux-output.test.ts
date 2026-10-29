import assert from "node:assert/strict";
import test from "node:test";
import { fluxAssetUrl } from "../lib/flux-output.ts";

test("reads the FLUX image envelope", () => {
  assert.equal(fluxAssetUrl({ result: { sample: "https://example.com/image.png" } }), "https://example.com/image.png");
});

test("reads the FLUX video envelope", () => {
  assert.equal(fluxAssetUrl({ result: { sample: "https://example.com/clip.mp4" } }), "https://example.com/clip.mp4");
});

test("refuses anything that is not an https asset", () => {
  assert.equal(fluxAssetUrl({ result: { sample: "http://example.com/image.png" } }), undefined);
  assert.equal(fluxAssetUrl({ result: { sample: "javascript:alert(1)" } }), undefined);
  assert.equal(fluxAssetUrl({ result: { sample: 42 } }), undefined);
});

test("refuses the wrong envelope", () => {
  assert.equal(fluxAssetUrl({ images: [{ url: "https://example.com/image.png" }] }), undefined);
  assert.equal(fluxAssetUrl({ result: null }), undefined);
  assert.equal(fluxAssetUrl(undefined), undefined);
});
