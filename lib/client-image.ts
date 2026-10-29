/**
 * Browser-side image prep for reference uploads.
 *
 * A phone photo can be 12 MP and 8 MB. FLUX does not need that, and neither
 * does the request body, so the reference is redrawn onto a canvas at a stable
 * long edge before it is sent.
 */

import { getMediaBlob, putMedia } from "./browser-media.ts";
import { MAX_MEDIA_MB } from "./media-uri.ts";

/** The audio/video reference ceiling, shared with the server's own check. */
export { MAX_MEDIA_MB };

/** A still bigger than this is not worth sending to a reference slot. */
export const MAX_INPUT_BYTES = 12 * 1024 * 1024;

/** References are scaled to at most one megapixel of total pixels. */
export const MAX_REFERENCE_PIXELS = 1_000_000;

/** Long-edge cap, so a square reference lands at 1000×1000 rather than 1024². */
export function fitWithinPixels(width: number, height: number, maxPixels = MAX_REFERENCE_PIXELS) {
  const source = Math.max(1, width) * Math.max(1, height);
  const scale = Math.min(1, Math.sqrt(maxPixels / source));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function decode(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read that image."));
    image.src = src;
  });
}

export type Reference = {
  /** JPEG data URL, used for the in-app preview. */
  preview: string;
  /** Raw base64, what the API expects. */
  base64: string;
  width: number;
  height: number;
  /** Original file name, shown in the upload row. */
  name: string;
  /** Size of the prepared JPEG in megabytes. */
  mb: number;
};

/** Redraw a decoded image at 1 MP and encode it for the API. */
function encodeReference(image: HTMLImageElement, name: string): Reference {
  const size = fitWithinPixels(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser blocked canvas rendering.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const preview = canvas.toDataURL("image/jpeg", 0.9);
  const base64 = preview.split(",", 2)[1];
  if (!base64) throw new Error("Could not encode that image.");

  return {
    preview,
    base64,
    width: size.width,
    height: size.height,
    name,
    mb: (base64.length * 3) / 4 / (1024 * 1024),
  };
}

export async function prepareReference(file: File): Promise<Reference> {
  if (!file.type.startsWith("image/")) throw new Error("Choose a PNG, JPEG or WebP image.");
  if (file.size > MAX_INPUT_BYTES) throw new Error("That image is larger than 12 MB.");

  const url = URL.createObjectURL(file);
  try {
    return encodeReference(await decode(url), file.name);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Reuse something already on the canvas: a render, or a previous upload held
 * as a preview/object URL. Same ceiling and same 1 MP pass as a file, so the
 * API never sees a 4 MP still repurposed as a reference.
 */
export async function referenceFromSrc(src: string, name: string): Promise<Reference> {
  const blob = await getMediaBlob(src);
  if (!blob) throw new Error("Could not read that image.");

  if (blob.type && !blob.type.startsWith("image/")) throw new Error("That asset is not an image.");
  if (blob.size > MAX_INPUT_BYTES) throw new Error("That image is larger than 12 MB.");

  const url = URL.createObjectURL(blob);
  try {
    return encodeReference(await decode(url), name);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** An uploaded audio or video file, kept as a data URI for the API. */
export type MediaFile = {
  name: string;
  base64: string;
  dataUrl: string;
  mb: number;
  /** Clip or track length when the browser can read it. */
  seconds?: number;
};

/** A blob the page just produced (a re-encoded tail), as a data URI. */
export function dataUrlFromBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the trimmed clip."));
    reader.readAsDataURL(blob);
  });
}

const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
};

/** Blob types can be empty (object URLs of some files), so names fill in. */
function mediaMime(name: string, type?: string) {
  // `video/webm;codecs=vp9,opus` is a valid Blob type but not a valid data
  // URL media type for the <video> element or the route's MEDIA_URI check.
  // Keep only the base type.
  const base = type?.split(";", 1)[0]?.trim().toLowerCase();
  if (base && /^(audio|video)\//.test(base)) return base;

  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function encodeMedia(bytes: Uint8Array, mime: string, name: string): MediaFile {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(offset, offset + 0x8000)));
  }
  const base64 = btoa(binary);

  return {
    name,
    base64,
    dataUrl: `data:${mime};base64,${base64}`,
    mb: bytes.byteLength / (1024 * 1024),
  };
}

/**
 * Read a clip's length without keeping an element around.
 * MediaRecorder WebMs often report `Infinity` until they are seeked once, so
 * the probe nudges the element and waits for `durationchange`.
 */
function probeSeconds(src: string, kind: "audio" | "video"): Promise<number | undefined> {
  return new Promise((resolve) => {
    const element = document.createElement(kind === "video" ? "video" : "audio");
    let settled = false;
    let timer = 0;

    const finish = (value?: number) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      element.removeEventListener("loadedmetadata", onMeta);
      element.removeEventListener("durationchange", attempt);
      element.removeEventListener("timeupdate", attempt);
      element.removeEventListener("seeked", attempt);
      element.removeEventListener("error", fail);
      element.removeAttribute("src");
      element.load();
      resolve(value);
    };
    const attempt = () => {
      if (Number.isFinite(element.duration) && element.duration > 0) finish(element.duration);
    };
    const fail = () => finish(undefined);
    const onMeta = () => {
      if (Number.isFinite(element.duration) && element.duration > 0) {
        finish(element.duration);
        return;
      }
      try {
        element.currentTime = 1e7;
      } catch {
        finish(undefined);
      }
    };

    timer = window.setTimeout(() => finish(undefined), 4000);
    element.preload = "metadata";
    element.addEventListener("loadedmetadata", onMeta);
    element.addEventListener("durationchange", attempt);
    element.addEventListener("timeupdate", attempt);
    element.addEventListener("seeked", attempt);
    element.addEventListener("error", fail);
    element.src = src;
  });
}

/**
 * Audio and video references are sent through untouched.
 *
 * No canvas step: re-encoding a clip is exactly how you ruin a motion
 * reference. The size ceiling is what stops a 200 MB upload.
 */
export async function prepareMedia(file: File, maxMb = MAX_MEDIA_MB, seconds?: number): Promise<MediaFile> {
  const mb = file.size / (1024 * 1024);
  if (mb > maxMb) throw new Error(`That file is ${mb.toFixed(1)} MB. Keep it under ${maxMb} MB.`);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = mediaMime(file.name, file.type);
  const encoded = encodeMedia(bytes, mime, file.name);

  if (seconds && Number.isFinite(seconds)) return { ...encoded, seconds };

  const kind = mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : undefined;
  if (!kind) return encoded;
  return { ...encoded, seconds: await probeSeconds(encoded.dataUrl, kind) };
}

/** Reuse a clip or track already in the library through its URL. */
export async function mediaFromSrc(
  src: string,
  name: string,
  maxMb = MAX_MEDIA_MB,
  seconds?: number,
): Promise<MediaFile> {
  const response = await getMediaBlob(src);
  if (!response) throw new Error("Could not read that file.");

  const blob = response;
  const mb = blob.size / (1024 * 1024);
  if (mb > maxMb) throw new Error(`That file is ${mb.toFixed(1)} MB. Keep it under ${maxMb} MB.`);

  const mime = mediaMime(name, blob.type);
  if (!/^(audio|video)\//i.test(mime)) throw new Error("That asset is not audio or video.");

  const encoded = encodeMedia(new Uint8Array(await blob.arrayBuffer()), mime, name);
  if (seconds && Number.isFinite(seconds)) return { ...encoded, seconds };

  const kind = mime.startsWith("video/") ? "video" : "audio";
  return { ...encoded, seconds: await probeSeconds(encoded.dataUrl, kind) };
}

/**
 * Put an upload in this browser's media store and return its source.
 *
 * The library is part of the project, so an upload has to outlive the tab: an
 * object URL dies with the page and a base64 preview would bloat the project
 * record. Bytes go to IndexedDB, which is also where a render lands, so an
 * upload can be re-read later as a reference, a clip or a track.
 */
export async function saveUpload(file: File): Promise<string> {
  return putMedia(file, file.name);
}
