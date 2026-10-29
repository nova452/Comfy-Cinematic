"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A chip that opens a small picker above itself.
 *
 * Shared by the two video-panel chips (aspect ratio, resolution) so both look
 * and behave the same. The panel body scrolls and can be shorter than its
 * content, so the popover is measured after mount and clamped into the window:
 * above the chip when it fits, otherwise the nearest edge that does.
 */

export type ChipPickerItem = {
  id: string;
  label: string;
  /** Small shape or glyph above the label. */
  icon?: ReactNode;
  /** Secondary line, e.g. the pixel size. */
  note?: string;
};

type Props = {
  /** Heading inside the popover. */
  heading: string;
  /** Text on the chip. */
  label: string;
  /** Tooltip / accessible name for the chip. */
  title: string;
  items: ChipPickerItem[];
  value: string;
  disabled?: boolean;
  /** The value is decided elsewhere (reference media), so the chip cannot open. */
  locked?: boolean;
  /** Why it is locked; becomes the chip's tooltip. */
  lockedHint?: string;
  onChange: (id: string) => void;
};

export function ChipPicker({ heading, label, title, items, value, disabled, locked, lockedHint, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ left: number; top: number }>();
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (wrapRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = wrapRef.current?.getBoundingClientRect();
    const pop = popRef.current;
    if (!anchor || !pop) return;

    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    const margin = 8;

    const left = Math.min(Math.max(margin, anchor.left), window.innerWidth - width - margin);
    const above = anchor.top - height - 8;
    const below = anchor.bottom + 8;
    const top = Math.max(margin, Math.min(above >= margin ? above : below, window.innerHeight - height - margin));

    setBox({ left, top });
  }, [open]);

  return (
    <div className="chip-picker" ref={wrapRef}>
      <button
        type="button"
        className={`chip is-picker${locked ? " is-locked" : ""}`}
        aria-haspopup={locked ? undefined : "dialog"}
        aria-expanded={locked ? undefined : open}
        title={locked ? (lockedHint ?? title) : title}
        disabled={disabled || locked}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          setBox(undefined);
          setOpen(true);
        }}
      >
        {label}
        {locked ? (
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2.5" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
            <path d="M6 15l6-6 6 6" />
          </svg>
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={popRef}
            className="chip-pop"
            role="dialog"
            aria-label={heading}
            style={{
              left: box?.left ?? 0,
              top: box?.top ?? 0,
              visibility: box ? "visible" : "hidden",
            }}
          >
            <span className="chip-pop-label">{heading}</span>
            <div className="chip-grid">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={value === item.id ? "is-active" : ""}
                  aria-pressed={value === item.id}
                  onClick={() => {
                    onChange(item.id);
                    setOpen(false);
                  }}
                >
                  {item.icon ? <span className="chip-option-icon">{item.icon}</span> : null}
                  <span className="chip-option-name">{item.label}</span>
                  {item.note ? <span className="chip-option-note">{item.note}</span> : null}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
