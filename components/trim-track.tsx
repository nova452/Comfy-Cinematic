"use client";

import { useEffect, useRef } from "react";
import { snapWindow } from "../lib/video";

type Props = {
  total: number;
  start: number;
  end: number;
  /** Shortest selectable window, in seconds. */
  min?: number;
  /** Longest selectable window, in seconds. */
  max?: number;
  /** Snap unit: 1 for whole seconds, 0.1 in the clip editor. */
  step?: number;
  disabled?: boolean;
  onWindow: (start: number, end: number) => void;
  onPreview?: (seconds: number) => void;
  className?: string;
  children?: React.ReactNode;
};

/**
 * The draggable window over a media track.
 *
 * Shared by the output-length picker and the pre-upload clip editor; the only
 * difference is the snap unit.
 */
export function TrimTrack({
  total,
  start,
  end,
  min = 1,
  max = total,
  step = 1,
  disabled,
  onWindow,
  onPreview,
  className,
  children,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: "start" | "end" | "move"; originX: number; start: number; end: number } | null>(null);
  const release = useRef<(() => void) | undefined>(undefined);

  useEffect(() => () => release.current?.(), []);

  const unit = Math.max(0.001, step);
  const ceiling = Math.max(unit, Math.floor(total / unit) * unit);
  const minWindow = Math.min(Math.max(unit, min), ceiling);
  const maxWindow = Math.min(max, ceiling);
  const usable = total > 0 && !disabled;

  function timeAt(clientX: number, rect: DOMRect) {
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * total;
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!usable) return;
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const bounds = rect;

    const time = timeAt(event.clientX, bounds);
    const nearStart = Math.abs(event.clientX - (bounds.left + (start / total) * bounds.width)) < 14;
    const nearEnd = Math.abs(event.clientX - (bounds.left + (end / total) * bounds.width)) < 14;

    const mode = nearStart ? "start" : nearEnd ? "end" : "move";
    let state: { mode: "start" | "end" | "move"; originX: number; start: number; end: number } = {
      mode,
      originX: event.clientX,
      start,
      end,
    };

    if (mode === "move" && (time < start || time > end)) {
      // Clicking outside the window recentres it on the pointer, snapped to
      // the track's unit so the readout stays tidy.
      const width = end - start;
      const next = snapWindow(time - width / 2, time + width / 2, total, minWindow, maxWindow, unit);
      onWindow(next.start, next.end);
      state = { mode: "move", originX: event.clientX, start: next.start, end: next.end };
    }

    drag.current = state;
    onPreview?.(mode === "end" ? end : start);
    event.preventDefault();

    const pointerId = event.pointerId;

    function onPointerMove(move: PointerEvent) {
      if (move.pointerId !== pointerId) return;
      const current = drag.current;
      if (!current) return;

      const delta = (move.clientX - current.originX) * (total / Math.max(1, bounds.width));
      let nextStart = current.start;
      let nextEnd = current.end;

      if (current.mode === "start") {
        nextStart = Math.min(Math.max(0, current.start + delta), current.end - minWindow);
      } else if (current.mode === "end") {
        nextEnd = Math.max(Math.min(ceiling, current.end + delta), current.start + minWindow);
      } else {
        const width = current.end - current.start;
        nextStart = Math.min(Math.max(0, current.start + delta), Math.max(0, ceiling - width));
        nextEnd = nextStart + width;
      }

      const snapped = snapWindow(nextStart, nextEnd, total, minWindow, maxWindow, unit);
      onWindow(snapped.start, snapped.end);
      onPreview?.(current.mode === "end" ? snapped.end : snapped.start);
    }

    function teardown() {
      drag.current = null;
      release.current = undefined;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    }

    function onPointerUp(up: PointerEvent) {
      if (up.pointerId !== pointerId) return;
      teardown();
    }

    release.current = teardown;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }

  const left = total > 0 ? (start / total) * 100 : 0;
  const width = total > 0 ? (Math.max(0, end - start) / total) * 100 : 0;

  return (
    <div
      ref={trackRef}
      className={`trim-track${usable ? "" : " is-idle"}${className ? ` ${className}` : ""}`}
      role="group"
      aria-label="Trim range"
      onPointerDown={onPointerDown}
    >
      {children}
      {usable && (
        <div className="trim-window" style={{ left: `${left}%`, width: `${width}%` }}>
          <span className="trim-handle is-start" />
          <span className="trim-handle is-end" />
        </div>
      )}
    </div>
  );
}
