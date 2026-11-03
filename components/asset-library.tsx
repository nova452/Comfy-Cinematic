"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useMediaUrl } from "../lib/browser-media";
import { AssetTile, CloudIcon, KindIcon, PendingTile } from "./asset-tile";
import { useNearViewport } from "./near-viewport";

/** One file dialog for every kind the library holds. */
const ACCEPT_ALL = ASSET_KINDS.map((kind) => acceptFor(kind)).join(",");

/**
 * Tiles mounted at a time, and how many more each scroll to the bottom adds.
 * The grid is the whole library, uncapped, so it grows as you read it rather
 * than mounting every tile the moment the tab opens.
 */
const PAGE_SIZE = 24;

type LibraryTileProps = {
  asset: Asset;
  liked: boolean;
  disabled: boolean;
  onOpen: (asset: Asset) => void;
  onToggleLike: (id: string) => void;
};

/**
 * A tile bound to its asset, so the handlers it hands down stay the same
 * between renders and an unchanged tile skips the render altogether.
 */
const LibraryTile = memo(function LibraryTile({ asset, liked, disabled, onOpen, onToggleLike }: LibraryTileProps) {
  const open = useCallback(() => onOpen(asset), [onOpen, asset]);
  const toggle = useCallback(() => onToggleLike(asset.id), [onToggleLike, asset.id]);
  return <AssetTile asset={asset} liked={liked} disabled={disabled} onOpen={open} onToggleLike={toggle} />;
});

/** The full-size view, holding its own blob subscription. */
function ViewerMedia({ asset }: { asset: Asset }) {
  const url = useMediaUrl(asset.src);
  if (asset.kind === "image") return <img src={url} alt={asset.note ?? asset.name} draggable={false} />;
  if (asset.kind === "video") return <video src={url} controls autoPlay loop playsInline preload="metadata" />;
  return <audio src={url} controls autoPlay />;
}

function ViewerDownload({ asset }: { asset: Asset }) {
  const url = useMediaUrl(asset.src);
  return (
    <a className="button-link primary" href={url} download={asset.name}>
      Download
    </a>
  );
}

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
  /** Stop a render in flight, by its pending id. */
  onCancelPending?: (id: string) => void;
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
export const AssetLibrary = memo(function AssetLibrary({
  uploads,
  renders,
  liked,
  pending,
  onCancelPending,
  onUpload,
  onToggleLike,
}: Props) {
  // Each tile and the viewer subscribe to their own blob, so this panel does
  // not re-render as the library's media streams in.
  const [tab, setTab] = useState<AssetTab>("uploads");
  const [filter, setFilter] = useState<LibraryFilter>("recent");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [viewing, setViewing] = useState<Asset | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const inputRef = useRef<HTMLInputElement>(null);
  const [sentinelRef, atEnd] = useNearViewport<HTMLDivElement>({ once: false, margin: "600px" });

  const disabled = working;
  const shown = useMemo(
    () => pickLibrary({ uploads, renders, liked }, tab, filter),
    [uploads, renders, liked, tab, filter],
  );
  const likedSet = useMemo(() => new Set(liked), [liked]);
  const visible = shown.length > limit ? shown.slice(0, limit) : shown;
  const hasMore = shown.length > limit;

  // Grow while the bottom is in reach; still in reach after a page lands
  // (a tall panel) means the next page follows on the next render.
  useEffect(() => {
    if (atEnd && hasMore) setLimit((current) => current + PAGE_SIZE);
  }, [atEnd, hasMore, limit]);

  const open = useCallback((asset: Asset) => setViewing(asset), []);
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
                  setLimit(PAGE_SIZE);
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
              onClick={() => {
                setFilter(item.id);
                setLimit(PAGE_SIZE);
              }}
              disabled={disabled}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="asset-grid">
          {running.map((slot) => (
            <PendingTile
              key={slot.id}
              kind={slot.kind}
              prompt={slot.prompt}
              {...(onCancelPending ? { onCancel: () => onCancelPending(slot.id) } : {})}
            />
          ))}

          {visible.map((asset) => (
            <LibraryTile
              key={asset.id}
              asset={asset}
              liked={likedSet.has(asset.id)}
              disabled={disabled}
              onOpen={open}
              onToggleLike={onToggleLike}
            />
          ))}

          {shown.length === 0 && running.length === 0 && (
            <p className="asset-empty">{emptyCopy(filter, tab)}</p>
          )}
        </div>

        {hasMore && <div className="asset-more" ref={sentinelRef} aria-hidden="true" />}

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
                <ViewerMedia asset={viewing} />
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
                  <ViewerDownload asset={viewing} />
                </div>
              </aside>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
});
