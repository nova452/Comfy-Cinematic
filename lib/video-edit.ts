/**
 * Geometry for the clip editor that runs before a video joins the library.
 *
 * The preview and the export both call `cropRect()`, so what the frame shows
 * is exactly what MediaRecorder draws. Kept free of DOM APIs so the maths can
 * be tested under `node --test`.
 */

export type CropAspect = "original" | "16:9" | "9:16" | "1:1";

export const CROP_ASPECTS: readonly { id: CropAspect; label: string }[] = [
  { id: "original", label: "Original" },
  { id: "16:9", label: "16:9" },
  { id: "9:16", label: "9:16" },
  { id: "1:1", label: "1:1" },
];

const RATIOS: Record<Exclude<CropAspect, "original">, number> = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "1:1": 1,
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The target frame's ratio; "original" follows the source. */
export function aspectRatioFor(aspect: CropAspect, sourceWidth: number, sourceHeight: number) {
  if (aspect === "original") {
    return sourceWidth > 0 && sourceHeight > 0 ? sourceWidth / sourceHeight : 16 / 9;
  }
  return RATIOS[aspect];
}

/**
 * The window covering the last `frames` of a clip.
 *
 * Used when continuing: the prompt model may watch the whole clip, but the
 * model that renders only needs its tail. A clip shorter than the tail is
 * taken whole.
 */
export function tailWindow(duration: number, frames: number, fps = 24) {
  const span = Math.max(0, Math.min(duration, frames / fps));
  return { start: Number((duration - span).toFixed(3)), end: Number(duration.toFixed(3)) };
}

export type CropRect = { x: number; y: number; width: number; height: number };

/**
 * The visible part of the source, in source pixels.
 *
 * At zoom 1 this is the largest rect of the frame's ratio that fits inside
 * the source, centred on `focus`. Zooming shrinks it around the same point;
 * `focus` is clamped by clamping the resulting rect.
 */
export function cropRect(
  sourceWidth: number,
  sourceHeight: number,
  aspect: CropAspect,
  zoom = 1,
  focusX = 0.5,
  focusY = 0.5,
): CropRect {
  const width = Math.max(1, sourceWidth);
  const height = Math.max(1, sourceHeight);
  const ratio = aspectRatioFor(aspect, width, height);

  let cropWidth = width;
  let cropHeight = cropWidth / ratio;
  if (cropHeight > height) {
    cropHeight = height;
    cropWidth = cropHeight * ratio;
  }

  const scale = clamp(zoom, 1, 8);
  cropWidth /= scale;
  cropHeight /= scale;

  const centreX = clamp(focusX, 0, 1) * width;
  const centreY = clamp(focusY, 0, 1) * height;

  return {
    x: clamp(centreX - cropWidth / 2, 0, Math.max(0, width - cropWidth)),
    y: clamp(centreY - cropHeight / 2, 0, Math.max(0, height - cropHeight)),
    width: cropWidth,
    height: cropHeight,
  };
}

/**
 * Even output dimensions, long edge capped. Even sizes keep encoder chroma
 * planes happy and the API's validation simple.
 */
export function outputSize(rect: CropRect, maxEdge = 1280) {
  const scale = Math.min(1, maxEdge / Math.max(1, rect.width, rect.height));
  const even = (value: number) => {
    const rounded = Math.max(2, Math.round(value));
    return rounded % 2 === 0 ? rounded : rounded - 1;
  };

  return { width: even(rect.width * scale), height: even(rect.height * scale) };
}

/** True when the clip can be added untouched, without a re-encode. */
export function isUnedited(
  total: number,
  start: number,
  end: number,
  crop: CropRect,
  sourceWidth: number,
  sourceHeight: number,
) {
  return (
    total > 0 &&
    start <= 0.05 &&
    end >= total - 0.05 &&
    crop.x <= 0.5 &&
    crop.y <= 0.5 &&
    crop.width >= sourceWidth - 0.5 &&
    crop.height >= sourceHeight - 0.5
  );
}
