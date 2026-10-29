/**
 * Browser-side clip export for the pre-upload editor.
 *
 * There is no ffmpeg in the app, so a trim or crop is redrawn onto a canvas
 * and captured with MediaRecorder. That is a real re-encode; the editor only
 * takes this path when something actually changed and offers the untouched
 * file otherwise.
 */

import type { CropRect } from "./video-edit";
import { outputSize, tailWindow } from "./video-edit";

export type ClipPlan = {
  /** Seconds into the source. */
  start: number;
  end: number;
  /** The visible part of the source, in source pixels. */
  crop: CropRect;
  /** Output canvas size. */
  width: number;
  height: number;
  mime: string;
};

const MIME_CANDIDATES = [
  // Chromium can record WebM but (in some builds) cannot demux its own WebM
  // back into a <video>. MP4 records and plays reliably, and the API accepts
  // it. Firefox only records WebM, so that remains the fallback.
  "video/mp4",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

/** A MediaRecorder type this browser can write, if any. */
export function recorderMime() {
  if (typeof MediaRecorder === "undefined") return undefined;
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

/** File extension for the recorder's mime type. */
export function mimeExtension(mime: string) {
  return mime.toLowerCase().includes("mp4") ? "mp4" : "webm";
}

function seek(video: HTMLVideoElement, seconds: number) {
  return new Promise<void>((resolve, reject) => {
    if (Math.abs(video.currentTime - seconds) < 0.01) {
      resolve();
      return;
    }

    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("Could not seek that clip."));
    };
    const cleanup = () => {
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", fail);
    };

    video.addEventListener("seeked", done);
    video.addEventListener("error", fail);
    const duration = Number.isFinite(video.duration) ? video.duration : seconds;
    video.currentTime = Math.max(0, Math.min(seconds, duration));
  });
}

/**
 * Cut the last `frames` of a clip, re-encoded in the browser.
 *
 * Router takes a clip, never a time range, so a continuation has to hand it a
 * real file. This is the same canvas-and-MediaRecorder path the pre-upload
 * editor uses — the only cutter in the app — and it keeps the source audio.
 */
export async function recordTail(src: string, frames: number, fps = 24): Promise<Blob> {
  const mime = recorderMime();
  if (!mime) throw new Error("This browser cannot re-encode a clip.");

  const video = document.createElement("video");
  video.preload = "auto";
  video.playsInline = true;
  video.muted = true;
  // Off-screen rather than `display:none`: a hidden element can be throttled
  // and then the capture draws no new frames.
  video.style.cssText =
    "position:fixed;left:-10px;top:-10px;width:1px;height:1px;opacity:0;pointer-events:none";
  video.src = src;
  document.body.appendChild(video);

  try {
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error("That clip could not be read back."));
      };
      const cleanup = () => {
        video.removeEventListener("loadeddata", ready);
        video.removeEventListener("error", fail);
      };
      video.addEventListener("loadeddata", ready, { once: true });
      video.addEventListener("error", fail, { once: true });
    });

    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error("That clip's length could not be read.");
    }

    const window = tailWindow(video.duration, frames, fps);
    const crop: CropRect = { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight };
    const size = outputSize(crop);

    return await recordClip(video, { ...window, crop, ...size, mime });
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
  }
}

/**
 * Play the selected window at 1x and capture the redrawn frames.
 *
 * MediaRecorder records in real time, so a 7s window takes 7s. `onProgress`
 * receives elapsed and total seconds, throttled to ~10 updates a second so the
 * preview is not re-rendered on every frame.
 */
export async function recordClip(
  video: HTMLVideoElement,
  plan: ClipPlan,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("This browser cannot re-encode a clip.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;

  if (typeof canvas.captureStream !== "function") {
    throw new Error("This browser cannot capture a canvas stream.");
  }

  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser blocked canvas rendering.");

  const stream = canvas.captureStream(30);

  // Keep the source audio when the element exposes it. The canvas contributes
  // the cropped picture; the element contributes only sound.
  const element = video as HTMLVideoElement & { captureStream?: () => MediaStream };
  const captured = element.captureStream?.();
  const audio = captured?.getAudioTracks() ?? [];
  audio.forEach((track) => stream.addTrack(track));

  const recorder = new MediaRecorder(stream, {
    mimeType: plan.mime,
    videoBitsPerSecond: 4_000_000,
    audioBitsPerSecond: 128_000,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const stopped = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: plan.mime }));
    recorder.onerror = () => reject(new Error("The browser stopped recording that clip."));
  });

  let frame = 0;
  let lastReport = -1;
  let done = false;

  const stop = () => {
    if (done) return;
    done = true;
    if (recorder.state !== "inactive") recorder.stop();
  };

  function draw() {
    if (done) return;

    const { x, y, width, height } = plan.crop;
    context!.drawImage(video, x, y, width, height, 0, 0, plan.width, plan.height);

    if (onProgress) {
      const played = Math.max(0, Math.min(plan.end, video.currentTime) - plan.start);
      if (played - lastReport >= 0.1) {
        lastReport = played;
        onProgress(played, Math.max(0.1, plan.end - plan.start));
      }
    }

    if (video.currentTime >= plan.end - 0.02 || video.ended) {
      stop();
      return;
    }
    frame = requestAnimationFrame(draw);
  }

  await seek(video, plan.start);

  // Some browsers only capture an element's audio while it is unmuted.
  video.muted = false;
  recorder.start(100);

  try {
    try {
      await video.play();
    } catch {
      video.muted = true;
      await video.play();
    }

    frame = requestAnimationFrame(draw);
    const blob = await stopped;
    if (blob.size === 0) throw new Error("The edited clip came back empty.");
    return blob;
  } finally {
    cancelAnimationFrame(frame);
    video.pause();
    video.muted = true;
    if (recorder.state !== "inactive") recorder.stop();
    audio.forEach((track) => track.stop());
    stream.getTracks().forEach((track) => track.stop());
    captured?.getTracks().forEach((track) => track.stop());
  }
}
