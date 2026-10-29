import assert from "node:assert/strict";
import test from "node:test";
import { encodeWav, sliceSamples, waveformPeaks } from "../lib/audio-trim.ts";

test("waveform peaks are normalised and sized to the bucket count", () => {
  const samples = new Float32Array(1000);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin(index / 8) * 0.5;
  }

  const peaks = waveformPeaks(samples, 50);
  assert.equal(peaks.length, 50);
  assert.equal(Math.max(...peaks), 1);
  assert.ok(peaks.every((peak) => peak >= 0 && peak <= 1));
});

test("a silent buffer does not divide by zero", () => {
  const peaks = waveformPeaks(new Float32Array(400), 20);
  assert.equal(peaks.length, 20);
  assert.ok(peaks.every((peak) => Number.isFinite(peak) && peak === 0));
});

test("peaks survive an odd bucket count", () => {
  const samples = new Float32Array(10).fill(0.25);
  assert.equal(waveformPeaks(samples, 3).length, 3);
});

test("slicing maps seconds to samples and clamps to the buffer", () => {
  const sampleRate = 100;
  const samples = new Float32Array(1000).fill(1);

  assert.equal(sliceSamples(samples, sampleRate, 0, 2).length, 200);
  assert.equal(sliceSamples(samples, sampleRate, 2, 4).length, 200);
  // Asking past the end stops at the end.
  assert.equal(sliceSamples(samples, sampleRate, 8, 20).length, 200);
  // Negative starts clamp to zero.
  assert.equal(sliceSamples(samples, sampleRate, -1, 1).length, 100);
  // Reversed ranges collapse rather than throwing.
  assert.equal(sliceSamples(samples, sampleRate, 5, 4).length, 0);
});

test("wav output is a valid 16-bit pcm header", () => {
  const sampleRate = 8000;
  const left = new Float32Array(80).fill(0.5);
  const right = new Float32Array(80).fill(-0.5);
  const wav = encodeWav([left, right], sampleRate);

  const text = (offset: number, length: number) =>
    String.fromCharCode(...Array.from(wav.subarray(offset, offset + length)));
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

  assert.equal(text(0, 4), "RIFF");
  assert.equal(text(8, 4), "WAVE");
  assert.equal(text(12, 4), "fmt ");
  assert.equal(text(36, 4), "data");

  assert.equal(view.getUint16(20, true), 1, "PCM format");
  assert.equal(view.getUint16(22, true), 2, "stereo");
  assert.equal(view.getUint32(24, true), sampleRate);
  assert.equal(view.getUint16(34, true), 16, "16-bit");
  assert.equal(view.getUint32(40, true), 80 * 2 * 2, "data size");
  assert.equal(wav.byteLength, 44 + 80 * 2 * 2);
  assert.equal(view.getUint32(4, true), wav.byteLength - 8, "riff size");

  // First frame: left +0.5, right -0.5 as signed 16-bit.
  assert.ok(Math.abs(view.getInt16(44, true) - 0x3fff) <= 1);
  assert.equal(view.getInt16(46, true), -0x4000);
});

test("an empty channel list still yields a valid file", () => {
  const wav = encodeWav([], 8000);
  assert.equal(wav.byteLength, 44);
  assert.equal(String.fromCharCode(...Array.from(wav.subarray(0, 4))), "RIFF");
});
