"use client";

import { useEffect, useRef, useState } from "react";
import { mediaUrl } from "../lib/browser-media";
import {
  GITHUB_REPO,
  SITE_NAME,
  displayName,
  hostOf,
  shareText,
  xShareUrl,
} from "../lib/share";

type Props = {
  name: string;
  url: string;
  count: number;
  /** A still to use as the preview cover; clips cannot be shown as images. */
  cover?: string;
  onClose: () => void;
};

/**
 * The share sheet: a preview card in the shape of a store page, a post to X,
 * and the plain link.
 *
 * Opening X is a link rather than a `window.open` call so the browser treats
 * it as a real navigation and does not charge it to a pop-up blocker.
 */
export function ShareModal({ name, url, count, cover, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const [canNativeShare, setCanNativeShare] = useState(false);
  const resetTimer = useRef(0);

  useEffect(() => {
    setCanNativeShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
    return () => window.clearTimeout(resetTimer.current);
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const text = shareText(name, count);
  const host = hostOf(url);

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // The clipboard is blocked outside a secure context; the link can still
      // be selected from the address bar.
      setCopied(false);
    }
  }

  async function nativeShare() {
    try {
      await navigator.share({ title: displayName(name), text, url });
    } catch {
      // Dismissing the system share sheet is not a failure worth reporting.
    }
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Share project" onClick={onClose}>
      <div className="modal share-panel" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>Share</h2>
          <button type="button" aria-label="Close share" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="share-preview">
          <div className="share-preview-art">
            {cover ? <img src={mediaUrl(cover)} alt="" /> : <span className="share-preview-blank">No still yet</span>}
          </div>
          <div className="share-preview-meta">
            <span className="share-preview-kicker">{SITE_NAME}</span>
            <strong>{displayName(name)}</strong>
            <p>{text}</p>
            <div className="share-preview-tags">
              <span>Comfy Router</span>
              <span>{count === 1 ? "1 frame" : `${count} frames`}</span>
              <span>Open source</span>
            </div>
            <span className="share-preview-host">{host}</span>
          </div>
        </div>

        <div className="share-actions">
          <a
            className="button-link share-x"
            href={xShareUrl(text, url)}
            target="_blank"
            rel="noreferrer noopener"
            title="Open X with this project pre-filled"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
              <path d="M17.53 3h3.02l-6.6 7.54L21.75 21h-5.9l-4.62-6.04L5.95 21H2.92l7.06-8.07L2.25 3h6.05l4.18 5.52L17.53 3Zm-1.06 16.2h1.67L7.62 4.72H5.83L16.47 19.2Z" />
            </svg>
            Post on X
          </a>
          <button type="button" className={canNativeShare ? undefined : "is-wide"} onClick={() => void copy(url)}>
            {copied ? "Link copied" : "Copy link"}
          </button>
          {canNativeShare && (
            <button type="button" onClick={() => void nativeShare()}>
              More…
            </button>
          )}
        </div>

        <footer className="share-footer">
          <a href={GITHUB_REPO.url} target="_blank" rel="noreferrer noopener" title="Browse the source">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
              <path d="M12 .5C5.73.5.75 5.48.75 11.75c0 4.96 3.22 9.17 7.69 10.66.56.1.77-.24.77-.54v-1.9c-3.13.68-3.79-1.5-3.79-1.5-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.68.08-.68 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.39-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.57 0-1.23.44-2.23 1.16-3.02-.12-.28-.5-1.43.11-2.98 0 0 .94-.3 3.08 1.15a10.7 10.7 0 0 1 5.61 0c2.14-1.45 3.08-1.15 3.08-1.15.61 1.55.23 2.7.11 2.98.72.79 1.16 1.79 1.16 3.02 0 4.33-2.64 5.29-5.15 5.56.4.35.76 1.03.76 2.08v3.08c0 .3.2.65.78.54a11.26 11.26 0 0 0 7.68-10.66C23.25 5.48 18.27.5 12 .5Z" />
            </svg>
            {GITHUB_REPO.name}
          </a>
          <span>FLUX 3 stills · MiniMax H3 clips</span>
        </footer>
      </div>
    </div>
  );
}
