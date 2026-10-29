"use client";

import { useEffect, useRef, useState } from "react";
import { mimeExtension, recorderMime, recordClip } from "../lib/record-video";
import {
  CROP_ASPECTS,
  aspectRatioFor,
  cropRect,
  isUnedited,
  outputSize,
  type CropAspect,
} from "../lib/video-edit";
import { TrimTrack } from "./trim-track";

type Props = {
  file: File;
  onCancel: () => void;
  /** The file to add and the length of that result, in seconds. */
  onApply: (file: File, seconds: number) => void;
};

const MIN_WINDOW = 0.5;
/** Longest edge of the redrawn clip. */
const MAX_EDGE = 1280;
const PREVIEW_HEIGHT = 280;

const clock = (seconds: number) => `${seconds.toFixed(1)}s`;

/**
 * Trim or crop a clip before it joins the uploads library.
 *
 * The preview stage is positioned from the same `cropRect()` the exporter
 * draws, so dragging and zooming show exactly what gets recorded. Leaving the
 * clip untouched skips MediaRecorder entirely and adds the original file.
 */
export function VideoEditModal({ file, onCancel, onApply }: Props) {
  const [url, setUrl] = useState<string>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const panRelease = useRef<(() => void) | undefined>(undefined);

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [total, setTotal] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [aspect, setAspect] = useState<CropAspect>("original");
  const [zoom, setZoom] = useState(1);
  const [focus, setFocus] = useState({ x: 0.5, y: 0.5 });
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);

  useEffect(() => {
    return () => panRelease.current?.();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !working) onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, working]);

  const duration = Math.max(0, end - start);
  const crop = cropRect(size.width, size.height, aspect, zoom, focus.x, focus.y);
  const opened = size.width > 0 && size.height > 0;
  const edited = opened && !isUnedited(total, start, end, crop, size.width, size.height);
  const output = outputSize(crop, MAX_EDGE);
  const ratio = aspectRatioFor(aspect, size.width, size.height);
  const mime = recorderMime();
  const canEncode = Boolean(mime);

  const preview = opened
    ? {
        width: `${(size.width / crop.width) * 100}%`,
        left: `${-(crop.x / crop.width) * 100}%`,
        top: `${-(crop.y / crop.height) * 100}%`,
      }
    : { width: "100%", left: "0%", top: "0%" };

  function onLoadedMetadata() {
    const element = videoRef.current;
    if (!element) return;

    if (element.videoWidth > 0) setSize({ width: element.videoWidth, height: element.videoHeight });

    if (Number.isFinite(element.duration) && element.duration > 0) {
      setTotal(element.duration);
      setStart(0);
      setEnd(element.duration);
      return;
    }

    // Clips recorded with MediaRecorder report `Infinity` until a seek.
    const onSeeked = () => {
      element.removeEventListener("seeked", onSeeked);
      element.currentTime = 0;
      if (Number.isFinite(element.duration) && element.duration > 0) {
        setTotal(element.duration);
        setStart(0);
        setEnd(element.duration);
      } else {
        setError("Could not read this clip's length.");
      }
    };
    element.addEventListener("seeked", onSeeked);
    element.currentTime = 1e7;
  }

  /* ---------------------------------- pan ----------------------------------- */

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (working || !opened) return;
    const stage = stageRef.current;
    if (!stage) return;

    const pointerId = event.pointerId;
    const originX = event.clientX;
    const originY = event.clientY;
    const startFocus = focus;
    // The stage width shows `crop.width` source pixels, so a drag maps back
    // through that same scale.
    const sourcePerPixel = crop.width / Math.max(1, stage.clientWidth);
    event.preventDefault();

    function onPointerMove(move: PointerEvent) {
      if (move.pointerId !== pointerId) return;
      const nextX = Math.min(
        1,
        Math.max(0, startFocus.x - ((move.clientX - originX) * sourcePerPixel) / size.width),
      );
      const nextY = Math.min(
        1,
        Math.max(0, startFocus.y - ((move.clientY - originY) * sourcePerPixel) / size.height),
      );
      setFocus({ x: nextX, y: nextY });
    }

    function teardown() {
      panRelease.current = undefined;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    }

    function onPointerUp(up: PointerEvent) {
      if (up.pointerId !== pointerId) return;
      teardown();
    }

    panRelease.current = teardown;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }

  /* --------------------------------- export --------------------------------- */

  async function apply(useOriginal = false) {
    if (working) return;

    if (useOriginal || !edited) {
      onApply(file, total);
      return;
    }
    if (duration < MIN_WINDOW || !mime) {
      if (!mime) setError("This browser cannot re-encode a clip. Use the original.");
      return;
    }

    const element = videoRef.current;
    if (!element) return;

    setWorking(true);
    setProgress(0);
    setError(undefined);
    try {
      const blob = await recordClip(
        element,
        { start, end, crop, width: output.width, height: output.height, mime },
        (done, length) => setProgress(Math.min(1, done / Math.max(0.1, length))),
      );
      const base = file.name.replace(/\.[^.]+$/, "") || "clip";
      onApply(new File([blob], `${base}-edit.${mimeExtension(mime)}`, { type: blob.type || mime }), duration);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not edit that clip.");
    } finally {
      setWorking(false);
    }
  }

  function close() {
    if (!working) onCancel();
  }

  return (
    <div
      className="overlay video-edit-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Edit clip"
      onClick={close}
    >
      <div className="modal video-edit-panel" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>Edit clip</h2>
          <button type="button" aria-label="Close clip editor" onClick={close} disabled={working}>
            ✕
          </button>
        </header>

        <div
          ref={stageRef}
          className="video-edit-stage"
          style={{ aspectRatio: ratio, width: `min(100%, ${Math.round(PREVIEW_HEIGHT * ratio)}px)` }}
          onPointerDown={onPointerDown}
        >
          <video
            ref={videoRef}
            src={url}
            muted
            playsInline
            preload="metadata"
            style={preview}
            onLoadedMetadata={onLoadedMetadata}
            onError={() => setError("This browser could not decode that clip.")}
          />
        </div>

        <div className="video-edit-aspects" role="group" aria-label="Crop">
          {CROP_ASPECTS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={aspect === option.id ? "is-active" : ""}
              aria-pressed={aspect === option.id}
              onClick={() => setAspect(option.id)}
              disabled={working}
            >
              {option.label}
            </button>
          ))}
        </div>

        <label className="video-edit-zoom">
          <span>Zoom</span>
          <input
            type="range"
            min={1}
            max={2.5}
            step={0.05}
            value={zoom}
            disabled={working || !opened}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
          <span>{zoom.toFixed(1)}×</span>
        </label>

        <TrimTrack
          total={total}
          start={start}
          end={end}
          min={MIN_WINDOW}
          max={total}
          step={0.1}
          disabled={working || !opened}
          className="video-edit-track"
          onWindow={(nextStart, nextEnd) => {
            setStart(nextStart);
            setEnd(nextEnd);
          }}
          onPreview={(seconds) => {
            const element = videoRef.current;
            if (element) element.currentTime = Math.max(0, Math.min(seconds, Math.max(0, total - 0.05)));
          }}
        />

        <div className="trim-readout">
          <span>
            <b>{clock(start)}</b> → <b>{clock(end)}</b>
          </span>
          <strong>{clock(duration)}</strong>
        </div>

        <p className="video-edit-note">
          {edited
            ? `Crop ${output.width}×${output.height}. The edit is re-encoded in this browser.`
            : "Untouched. The original file is added as-is."}
        </p>

        {working && (
          <div className="video-edit-progress" role="status" aria-live="polite">
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
            <em>Rendering {Math.round(progress * 100)}%</em>
          </div>
        )}

        {error && (
          <p className="panel-status error" role="alert">
            {error}
          </p>
        )}
        {edited && !canEncode && !error && (
          <p className="panel-status error" role="alert">
            This browser cannot re-encode a clip. Use the original.
          </p>
        )}

        <div className="video-edit-actions">
          <button
            type="button"
            className="primary"
            onClick={() => void apply()}
            disabled={working || total <= 0 || (edited && (duration < MIN_WINDOW || !canEncode))}
          >
            {working ? "Rendering…" : edited ? "Add edited clip" : "Add clip"}
          </button>
          {edited && (
            <button type="button" onClick={() => void apply(true)} disabled={working}>
              Use original
            </button>
          )}
          <button type="button" onClick={close} disabled={working}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
