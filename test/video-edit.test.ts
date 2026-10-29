import assert from "node:assert/strict";
import test from "node:test";
import {
  CROP_ASPECTS,
  aspectRatioFor,
  cropRect,
  isUnedited,
  outputSize,
  tailWindow,
} from "../lib/video-edit.ts";

const close = (value: number, expected: number) => assert.ok(Math.abs(value - expected) < 0.001, `${value} != ${expected}`);

test("the ratio presets follow the source when set to original", () => {
  assert.deepEqual(
    CROP_ASPECTS.map((item) => item.id),
    ["original", "16:9", "9:16", "1:1"],
  );
  close(aspectRatioFor("original", 1920, 1080), 16 / 9);
  close(aspectRatioFor("original", 1080, 1920), 9 / 16);
  close(aspectRatioFor("original", 0, 0), 16 / 9);
  close(aspectRatioFor("9:16", 0, 0), 9 / 16);
});

test("a continuation takes the last frames of the clip", () => {
  // 22 frames at 24 fps is just under a second, taken from the end.
  const window = tailWindow(5, 22, 24);
  close(window.start, 5 - 22 / 24);
  close(window.end, 5);

  // A clip shorter than the tail is taken whole rather than going negative.
  assert.deepEqual(tailWindow(0.5, 22, 24), { start: 0, end: 0.5 });
  assert.deepEqual(tailWindow(0.5, 22, 24).start, 0);
});

test("a crop is the largest matching rect inside the source", () => {
  const square = cropRect(1920, 1080, "1:1");
  close(square.width, 1080);
  close(square.height, 1080);
  close(square.x, 420);
  close(square.y, 0);

  const wide = cropRect(1080, 1920, "16:9");
  close(wide.width, 1080);
  close(wide.height, 607.5);
  close(wide.x, 0);
  close(wide.y, 656.25);

  assert.deepEqual(cropRect(1000, 600, "original"), { x: 0, y: 0, width: 1000, height: 600 });
});

test("zoom shrinks around the focus and never leaves the source", () => {
  const zoomed = cropRect(1000, 1000, "original", 2);
  close(zoomed.width, 500);
  close(zoomed.height, 500);
  close(zoomed.x, 250);
  close(zoomed.y, 250);

  const left = cropRect(1000, 1000, "original", 2, 0, 0.5);
  close(left.x, 0);
  const right = cropRect(1000, 1000, "original", 2, 1, 0.5);
  close(right.x, 500);

  // Focus outside [0,1] is clamped, not accepted.
  close(cropRect(1000, 1000, "original", 2, -4, 4).x, 0);
  close(cropRect(1000, 1000, "original", 2, -4, 4).y, 500);
});

test("output size caps the long edge and keeps dimensions even", () => {
  assert.deepEqual(outputSize({ x: 0, y: 0, width: 1920, height: 1080 }), { width: 1280, height: 720 });
  assert.deepEqual(outputSize({ x: 0, y: 0, width: 1000, height: 601 }), { width: 1000, height: 600 });
  assert.deepEqual(outputSize({ x: 0, y: 0, width: 1080, height: 1920 }), { width: 720, height: 1280 });
  assert.deepEqual(outputSize({ x: 0, y: 0, width: 1, height: 1 }), { width: 2, height: 2 });
});

test("an untouched clip skips the re-encode", () => {
  const full = { x: 0, y: 0, width: 1000, height: 600 };
  assert.equal(isUnedited(7.4, 0, 7.4, full, 1000, 600), true);
  assert.equal(isUnedited(7.4, 0.1, 7.4, full, 1000, 600), false);
  assert.equal(isUnedited(7.4, 0, 7.3, full, 1000, 600), false);
  assert.equal(isUnedited(7.4, 0, 7.4, { ...full, width: 800 }, 1000, 600), false);
  assert.equal(isUnedited(7.4, 0, 7.4, { ...full, x: 100 }, 1000, 600), false);
  assert.equal(isUnedited(0, 0, 0, full, 1000, 600), false);
});
