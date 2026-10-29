"use client";

import type { Asset, AssetKind } from "../lib/assets";
import { mediaUrl } from "../lib/browser-media";

export function CloudIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path
        d="M12 19.25V11.75M12 11.75l2.5 2.5M12 11.75l-2.5 2.5M15 19.25h3.125a4.125 4.125 0 000-8.25h-.13a6 6 0 10-11.67 2.04A3.875 3.875 0 007 19.25h2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="M12 4.5l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4L4.2 10.2l5.4-.8z" />
    </svg>
  );
}

export function KindIcon({ kind }: { kind: AssetKind }) {
  if (kind === "audio") {
    return (
      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2">
        <path d="M4 10v4M8 7v10M12 5v14M16 8v8M20 11v2" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "video") {
    return (
      <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
        <path d="M8 5l11 7-11 7z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <circle cx="8.5" cy="9.5" r="1.6" />
      <path d="M4 17l5-4 4 3 3-2 4 3" />
    </svg>
  );
}

type Props = {
  asset: Asset;
  liked: boolean;
  disabled?: boolean;
  /** What opening the tile does: fill a slot, or show it full size. */
  onOpen: () => void;
  /** Absent on tiles that are not library entries, like the bundled samples. */
  onToggleLike?: () => void;
};

/**
 * One asset in a grid: a preview, its name, and the star that keeps it.
 *
 * The picker opens a tile into a slot; the Assets tab opens it full size. Both
 * take `onOpen`, so a tile always does something when it is clicked.
 */
export function AssetTile({ asset, liked, disabled, onOpen, onToggleLike }: Props) {
  const title = asset.note ?? asset.name;

  return (
    <div className="asset-tile">
      <button type="button" className="asset-open" title={title} onClick={onOpen} disabled={disabled}>
        <span className={`asset-preview is-${asset.kind}`} aria-hidden="true">
          {asset.kind === "image" ? (
            <img src={mediaUrl(asset.src)} alt="" loading="lazy" draggable={false} />
          ) : asset.kind === "video" ? (
            <video src={mediaUrl(asset.src)} muted playsInline preload="metadata" />
          ) : (
            <span className="asset-audio-glyph">
              <KindIcon kind="audio" />
            </span>
          )}
          <span className="asset-badge">
            <KindIcon kind={asset.kind} />
          </span>
          {asset.kind === "video" && asset.seconds ? (
            <span className="asset-duration">{asset.seconds}s</span>
          ) : null}
        </span>
        <span className="asset-label">{asset.name}</span>
      </button>

      {onToggleLike && (
        <button
          type="button"
          className={`asset-star${liked ? " is-liked" : ""}`}
          aria-pressed={liked}
          aria-label={liked ? `Unstar ${asset.name}` : `Star ${asset.name}`}
          title={liked ? "Remove from Saved" : "Add to Saved"}
          onClick={onToggleLike}
          disabled={disabled}
        >
          <StarIcon filled={liked} />
        </button>
      )}
    </div>
  );
}

type PendingProps = {
  kind: AssetKind;
  prompt: string;
};

/**
 * A render that has not landed yet, drawn the way the canvas draws it: a
 * blueprint square that fills from the bottom while the work runs. The library
 * should not look empty just because the newest asset is still cooking.
 */
export function PendingTile({ kind, prompt }: PendingProps) {
  return (
    <div className="asset-tile">
      <div className="asset-pending" data-kind={kind} title={prompt}>
        <span className="asset-pending-icon">
          <KindIcon kind={kind} />
        </span>
        <span className="asset-pending-label">Rendering</span>
      </div>
      <span className="asset-label">{prompt}</span>
    </div>
  );
}
