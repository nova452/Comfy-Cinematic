"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ASSET_KINDS,
  ASSET_TABS,
  acceptFor,
  assetKindFrom,
  fitsKind,
  libraryFilters,
  pickLibrary,
  type Asset,
  type AssetTab,
  type LibraryFilter,
} from "../lib/assets";
import { MAX_INPUT_BYTES, MAX_MEDIA_MB, prepareMedia, saveUpload } from "../lib/client-image";
import { mediaUrl, useMediaVersion } from "../lib/browser-media";
import { AssetTile, CloudIcon, KindIcon, PendingTile } from "./asset-tile";

/** One file dialog for every kind the library holds. */
const ACCEPT_ALL = ASSET_KINDS.map((kind) => acceptFor(kind)).join(",");

/** A render that is running right now, as far as this panel cares. */
export type PendingAsset = { id: string; kind: "image" | "video"; prompt: string };

function emptyCopy(filter: LibraryFilter, tab: AssetTab) {
  if (tab === "liked") return "Nothing starred yet.";
  if (filter === "recent") {
    return tab === "generations" ? "Nothing rendered yet." : "Nothing here yet.";
  }
  const noun = filter === "image" ? "stills" : filter === "video" ? "clips" : "tracks";
  return `No ${noun} yet.`;
}

type Props = {
  uploads: Asset[];
  renders: Asset[];
  liked: string[];
  /** Renders in flight, so the library shows the gap they leave. */
  pending: PendingAsset[];
  busy?: boolean;
  onUpload: (asset: Asset) => void;
  onToggleLike: (id: string) => void;
};

/**
 * The Assets tab: the picker's library, open all the time.
 *
 * The picker exists because a slot needs one kind, so it hides the rest. This
 * panel belongs to no slot, so it shows the whole library in one scroll, mixed
 * newest-first — the kind badge on each tile is all the grouping it needs —
 * with a pill per kind for when you only want stills, clips or tracks.
 */
export function AssetLibrary({ uploads, renders, liked, pending, busy, onUpload, onToggleLike }: Props) {
  // Tiles and the full-size viewer fill in as their blobs are read.
  useMediaVersion();
  const [tab, setTab] = useState<AssetTab>("uploads");
  const [filter, setFilter] = useState<LibraryFilter>("recent");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [viewing, setViewing] = useState<Asset | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const disabled = Boolean(busy) || working;
  const shown = useMemo(
    () => pickLibrary({ uploads, renders, liked }, tab, filter),
    [uploads, renders, liked, tab, filter],
  );
  // A render in flight is the newest thing the library has, so it leads.
  const running = pending.filter((item) => filter === "recent" || item.kind === filter);
  const filters = libraryFilters(tab);

  useEffect(() => {
    if (!viewing) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setViewing(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing]);

  async function upload(file: File) {
    if (disabled) return;

    const kind = assetKindFrom(file);
    if (!kind || !fitsKind(file, kind)) {
      setError("Choose a PNG, JPEG or WebP image, an MP3, WAV or M4A track, or an MP4 or WebM clip.");
      return;
    }

    setWorking(true);
    setError(undefined);
    try {
      const id = `upload:${crypto.randomUUID()}`;
      const name = file.name || `upload.${kind === "image" ? "jpg" : kind === "audio" ? "mp3" : "mp4"}`;

      if (kind === "image") {
        // The same ceiling a reference slot enforces, or the tile could never
        // be picked afterwards.
        if (file.size > MAX_INPUT_BYTES) throw new Error("That image is larger than 12 MB.");
        onUpload({ id, kind, origin: "upload", name, src: await saveUpload(file), createdAt: Date.now() });
      } else {
        // Stored on the server, so the tile still works after a reload.
        const media = await prepareMedia(file, MAX_MEDIA_MB);
        const length = media.seconds && Number.isFinite(media.seconds) ? Math.round(media.seconds) : undefined;
        onUpload({
          id,
          kind,
          origin: "upload",
          name,
          src: await saveUpload(file),
          createdAt: Date.now(),
          ...(kind === "video" && length ? { seconds: length } : {}),
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read that file.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <div
        className="panel-body assets"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const file = event.dataTransfer.files?.[0];
          if (file) void upload(file);
        }}
      >
        <div className="asset-top">
          <div className="asset-tabs" role="tablist" aria-label="Asset source">
            {ASSET_TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={tab === item.id ? "is-active" : ""}
                onClick={() => {
                  setTab(item.id);
                  // Audio is upload-only, so landing on Output with it still
                  // selected would leave the grid empty with no way back.
                  if (item.id === "generations" && filter === "audio") setFilter("recent");
                }}
                disabled={disabled}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="asset-add"
            aria-label="Upload media"
            title="Upload an image, clip or track"
            onClick={() => inputRef.current?.click()}
            disabled={disabled}
          >
            <CloudIcon />
          </button>
        </div>

        <div className="asset-filter" role="tablist" aria-label="Filter assets">
          {filters.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={filter === item.id}
              className={filter === item.id ? "is-active" : ""}
              onClick={() => setFilter(item.id)}
              disabled={disabled}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="asset-grid">
          {running.map((slot) => (
            <PendingTile key={slot.id} kind={slot.kind} prompt={slot.prompt} />
          ))}

          {shown.map((asset) => (
            <AssetTile
              key={asset.id}
              asset={asset}
              liked={liked.includes(asset.id)}
              disabled={disabled}
              onOpen={() => setViewing(asset)}
              onToggleLike={() => onToggleLike(asset.id)}
            />
          ))}

          {shown.length === 0 && running.length === 0 && (
            <p className="asset-empty">{emptyCopy(filter, tab)}</p>
          )}
        </div>

        {error && (
          <p className="asset-error" role="alert">
            {error}
          </p>
        )}

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ALL}
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void upload(file);
          }}
        />
      </div>

      {viewing &&
        // The panel blurs its backdrop, which makes it a containing block for
        // fixed children — the viewer has to live on the body to be full size.
        createPortal(
          <div
            className="overlay viewer-overlay"
            role="dialog"
            aria-modal="true"
            aria-label={viewing.name}
            onClick={() => setViewing(null)}
          >
            <div className="viewer" onClick={(event) => event.stopPropagation()}>
              <div className="viewer-media">
                {viewing.kind === "image" ? (
                  <img src={mediaUrl(viewing.src)} alt={viewing.note ?? viewing.name} draggable={false} />
                ) : viewing.kind === "video" ? (
                  <video src={mediaUrl(viewing.src)} controls autoPlay loop playsInline preload="metadata" />
                ) : (
                  <audio src={mediaUrl(viewing.src)} controls autoPlay />
                )}
              </div>

              <aside className="viewer-panel">
                <header>
                  <span className="viewer-kind">
                    <KindIcon kind={viewing.kind} />
                    {viewing.kind}
                  </span>
                  <button
                    type="button"
                    className="viewer-close"
                    aria-label="Close viewer"
                    onClick={() => setViewing(null)}
                  >
                    ✕
                  </button>
                </header>

                <p className="viewer-prompt">{viewing.note?.trim() || viewing.name}</p>

                {/* The rewrite that was actually sent. Folded, because for a
                    clip it is a six-section brief rather than a prompt. */}
                {viewing.detail && (
                  <details className="viewer-sent">
                    <summary>Prompt sent</summary>
                    <p>{viewing.detail}</p>
                  </details>
                )}

                <div className="viewer-meta">
                  <span>
                    {viewing.origin === "upload" ? "Upload" : viewing.origin === "sample" ? "Sample" : "Render"}
                  </span>
                  {viewing.seconds ? <span>{viewing.seconds}s</span> : null}
                </div>

                <div className="viewer-actions">
                  <a className="button-link primary" href={mediaUrl(viewing.src)} download={viewing.name}>
                    Download
                  </a>
                </div>
              </aside>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
