"use client";

import { useEffect, useRef, useState } from "react";
import type { MediaFile } from "../lib/client-image";
import { encodeWav, sliceSamples, waveformPeaks } from "../lib/audio-trim";
import { TrimTrack } from "./trim-track";

type Props = {
  kind: "audio" | "video";
  media: MediaFile;
  minDuration: number;
  maxDuration: number;
  duration: number;
  onClose: () => void;
  onApply: (result: { duration: number; trimmed?: MediaFile }) => void;
};

function fromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(binary);
}

const clock = (seconds: number) => `${Math.round(seconds)}s`;

export function TrimModal({ kind, media, minDuration, maxDuration, duration, onClose, onApply }: Props) {
  const [total, setTotal] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [error, setError] = useState<string>();

  const videoRef = useRef<HTMLVideoElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<{ channels: Float32Array[]; sampleRate: number } | null>(null);

  const length = Math.max(0, end - start);
  /** Shortest selectable window: the model's own minimum. */
  const minWindow = Math.max(1, minDuration);
  /** What the provider is actually asked for, once the floor is applied. */
  const outputSeconds = Math.min(
    maxDuration,
    Math.max(minDuration, Math.round(Math.max(minWindow, length))),
  );
  const shorter = total > 0 && outputSeconds !== Math.round(length);

  function windowFor(seconds: number, source: number) {
    const wanted = Math.min(maxDuration, Math.max(minWindow, Math.round(seconds)));
    // A reference shorter than the model's floor is used whole rather than
    // chopped to the last whole second.
    if (source <= minWindow) return { start: 0, end: source };
    return { start: 0, end: Math.min(Math.max(1, Math.floor(source)), wanted) };
  }

  /* --------------------------------- loading -------------------------------- */

  useEffect(() => {
    if (kind !== "audio") return;
    let cancelled = false;

    (async () => {
      try {
        const context = new AudioContext();
        const bytes = fromBase64(media.base64);
        const buffer = await context.decodeAudioData(bytes.buffer.slice(0));
        if (cancelled) return;

        const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
          buffer.getChannelData(index).slice(),
        );
        audioRef.current = { channels, sampleRate: buffer.sampleRate };
        setPeaks(waveformPeaks(channels[0] ?? new Float32Array(), 240));
        setTotal(buffer.duration);

        const next = windowFor(duration, buffer.duration);
        setStart(next.start);
        setEnd(next.end);
        await context.close();
      } catch {
        if (!cancelled) setError("Could not decode that audio for the preview.");
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, media]);

  function applyTotal(seconds: number) {
    setTotal(seconds);
    const next = windowFor(duration, seconds);
    setStart(next.start);
    setEnd(next.end);
  }

  function onLoadedMetadata() {
    const element = videoRef.current;
    if (!element) return;

    if (Number.isFinite(element.duration) && element.duration > 0) {
      applyTotal(element.duration);
      return;
    }

    // Clips recorded with MediaRecorder (and some streamed files) report
    // `Infinity` until they have been seeked once.
    const onSeeked = () => {
      element.removeEventListener("timeupdate", onSeeked);
      element.currentTime = 0;
      if (Number.isFinite(element.duration) && element.duration > 0) {
        applyTotal(element.duration);
      } else {
        setError("Could not read this clip's length.");
      }
    };
    element.addEventListener("timeupdate", onSeeked);
    element.currentTime = 1e7;
  }

  /* --------------------------------- drawing -------------------------------- */

  useEffect(() => {
    const canvas = waveRef.current;
    if (!canvas || peaks.length === 0) return;

    const width = canvas.clientWidth || 520;
    const height = canvas.clientHeight || 64;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);

    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);

    const bar = width / peaks.length;
    context.fillStyle = "rgba(242, 255, 89, 0.55)";
    peaks.forEach((peak, index) => {
      const barHeight = Math.max(1, peak * (height - 6));
      context.fillRect(index * bar, (height - barHeight) / 2, Math.max(1, bar - 1), barHeight);
    });
  }, [peaks]);

  /* --------------------------------- preview -------------------------------- */

  function previewAt(seconds: number) {
    const element = videoRef.current;
    if (kind !== "video" || !element) return;
    if (Math.abs(element.currentTime - seconds) < 0.05) return;
    element.currentTime = Math.min(Math.max(0, seconds), Math.max(0, total - 0.05));
  }

  /* ---------------------------------- apply --------------------------------- */

  function apply() {
    if (total <= 0) {
      // Nothing could be decoded, so there is no range to apply — keep the
      // length the user already had rather than trapping them in the dialog.
      onApply({ duration });
      return;
    }

    const seconds = Math.max(minWindow, end - start);
    const output = Math.min(maxDuration, Math.max(minDuration, Math.round(seconds)));

    if (kind === "video" || !audioRef.current) {
      onApply({ duration: output });
      return;
    }
    const { channels, sampleRate } = audioRef.current;
    const sliced = channels.map((data) => sliceSamples(data, sampleRate, start, end));
    const wav = encodeWav(sliced, sampleRate);
    const base64 = toBase64(wav);

    onApply({
      duration: output,
      trimmed: {
        name: media.name.replace(/\.[^.]+$/, "") + "-trim.wav",
        base64,
        dataUrl: `data:audio/wav;base64,${base64}`,
        mb: wav.length / (1024 * 1024),
      },
    });
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={`Trim ${kind}`} onClick={onClose}>
      <div className="modal trim-panel" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>Trim</h2>
          <button type="button" aria-label="Close trim" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="trim-preview">
          {kind === "video" ? (
            <video
              ref={videoRef}
              src={media.dataUrl}
              muted
              playsInline
              preload="metadata"
              onLoadedMetadata={onLoadedMetadata}
              onError={() => setError("This browser could not decode that clip for the preview.")}
            />
          ) : (
            <div className="trim-audio">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M4 12h2l2-6 3 12 3-9 2 5 2-3h2" />
              </svg>
              <span>{media.name}</span>
            </div>
          )}
        </div>

        <TrimTrack
          total={total}
          start={start}
          end={end}
          min={minWindow}
          max={maxDuration}
          disabled={total > 0 && total <= minWindow}
          onWindow={(nextStart, nextEnd) => {
            setStart(nextStart);
            setEnd(nextEnd);
          }}
          onPreview={previewAt}
        >
          {kind === "audio" && <canvas ref={waveRef} className="trim-wave" />}
        </TrimTrack>

        <div className="trim-readout">
          <span>
            <b>{clock(start)}</b> → <b>{clock(end)}</b>
          </span>
          <strong>{clock(length)}</strong>
        </div>
        {shorter && (
          <p className="trim-note">
            This reference is {clock(length)}; the model outputs {outputSeconds}s.
          </p>
        )}
        {error && <p className="panel-status error">{error}</p>}

        <div className="panel-actions">
          <button type="button" className="primary" onClick={apply}>
            {total > 0 ? `Use ${outputSeconds}s` : `Keep ${duration}s`}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
