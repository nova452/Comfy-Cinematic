/**
 * Trimming helpers for uploaded audio.
 *
 * A reference cllip is sent to the provider as a file, so trimming has to
 * happen in the browser. These are plain sample-array operations: no DOM, no
 * WebAudio, which makes them testable and keeps the component thin.
 */

/** Peak envelope for the waveform, normalised to 0–1. */
export function waveformPeaks(samples: Float32Array, buckets: number): number[] {
  const count = Math.max(1, Math.floor(buckets));
  const size = Math.max(1, Math.floor(samples.length / count));
  const peaks: number[] = [];

  for (let index = 0; index < count; index += 1) {
    const from = index * size;
    const to = Math.min(samples.length, from + size);
    let peak = 0;
    for (let cursor = from; cursor < to; cursor += 1) {
      const value = Math.abs(samples[cursor] ?? 0);
      if (value > peak) peak = value;
    }
    peaks.push(peak);
  }

  const loudest = Math.max(0.0001, ...peaks);
  return peaks.map((value) => value / loudest);
}

/** Samples between two times, clamped to the buffer. */
export function sliceSamples(samples: Float32Array, sampleRate: number, startSeconds: number, endSeconds: number) {
  const from = Math.max(0, Math.floor(Math.max(0, startSeconds) * sampleRate));
  const to = Math.min(samples.length, Math.ceil(Math.max(startSeconds, endSeconds) * sampleRate));
  return samples.slice(from, Math.max(from, to));
}

/**
 * 16-bit PCM WAV. Small, lossless, and accepted everywhere — re-encoding to a
 * compressed codec would only add quality loss for a few hundred kilobytes.
 */
export function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const channelCount = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  ascii(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channel]?.[frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }

  return new Uint8Array(buffer);
}
