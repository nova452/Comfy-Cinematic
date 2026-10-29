import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MEDIA_CHARS,
  isBase64Payload,
  isBase64Value,
  isMediaUri,
} from "../lib/media-uri.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("base64 payloads are accepted, padding and all", () => {
  assert.equal(isBase64Payload(PNG), true);
  assert.equal(isBase64Payload("QUJD"), true);
  assert.equal(isBase64Payload("QUJDRA=="), true);
  assert.equal(isBase64Payload("QUJDRA="), true);
  assert.equal(isBase64Payload("+/+/"), true);
});

test("anything outside the alphabet is refused", () => {
  assert.equal(isBase64Payload(""), false);
  assert.equal(isBase64Payload("="), false);
  assert.equal(isBase64Payload("QUJD===="), false);
  assert.equal(isBase64Payload("QU JD"), false);
  assert.equal(isBase64Payload("QUJD\n"), false);
  assert.equal(isBase64Payload("QU-D"), false);
  assert.equal(isBase64Value("QUJD", 100), false); // too short to be a still
});

test("a clip the size of a real reference does not overflow", () => {
  // Regression: this exact shape used to throw
  // `RangeError: Maximum call stack size exceeded` from an anchored regex.
  const payload = "A".repeat(4_000_000);
  assert.equal(isBase64Payload(payload), true);
  assert.equal(isMediaUri(`data:video/mp4;base64,${payload}`, "video"), true);
});

test("a media URI must be the right kind, well formed, and within the cap", () => {
  const uri = `data:video/mp4;base64,${PNG}`;
  assert.equal(isMediaUri(uri, "video"), true);
  assert.equal(isMediaUri(uri, "audio"), false);
  assert.equal(isMediaUri(`data:audio/wav;base64,${PNG}`, "audio"), true);
  assert.equal(isMediaUri(`data:audio/wav;base64,${PNG}`, "video"), false);
  assert.equal(isMediaUri(`data:text/plain;base64,${PNG}`, "video"), false);
  assert.equal(isMediaUri(`data:video/mp4,${PNG}`, "video"), false);
  assert.equal(isMediaUri(`data:video/mp4;base64,${PNG}!`, "video"), false);
  assert.equal(isMediaUri(uri, "video", 8), false);
  assert.equal(isMediaUri(`data:video/mp4;base64,${PNG}`, "video", MAX_MEDIA_CHARS), true);
});
