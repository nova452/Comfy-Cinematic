"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ASSET_TABS,
  SAMPLES_TAB,
  acceptFor,
  fitsKind,
  pickAssets,
  type Asset,
  type AssetKind,
  type AssetSort,
  type AssetTab,
} from "../lib/assets";
import {
  MAX_MEDIA_MB,
  mediaFromSrc,
  prepareMedia,
  prepareReference,
  referenceFromSrc,
  saveUpload,
  type MediaFile,
  type Reference,
} from "../lib/client-image";
import { VideoEditModal } from "./video-edit-modal";
import { AssetTile, CloudIcon } from "./asset-tile";

export type PickedAsset =
  | { kind: "image"; asset: Asset; reference: Reference }
  | { kind: "audio" | "video"; asset: Asset; media: MediaFile };

type Props = {
  /** What the slot can take. Everything else in the library stays hidden. */
  kind: AssetKind;
  /** Used as the dialog's accessible name. */
  title: string;
  uploads: Asset[];
  renders: Asset[];
  liked: string[];
  busy?: boolean;
  onClose: () => void;
  onPick: (picked: PickedAsset) => void;
  onUpload: (asset: Asset) => void;
  onToggleLike: (id: string) => void;
};

function kindError(kind: AssetKind) {
  return kind === "image"
    ? "Choose a PNG, JPEG or WebP image."
    : kind === "audio"
      ? "Choose an MP3, WAV or M4A track."
      : "Choose an MP4 or WebM clip.";
}

/**
 * The middle ground between a reference slot and the file system.
 *
 * One panel lists everything this session has uploaded plus every render in
 * the project. Choosing a tile hands the slot a prepared reference, so a still
 * on the canvas can become a first frame without downloading and re-uploading
 * it.
 */
export function AssetPicker({
  kind,
  title,
  uploads,
  renders,
  liked,
  busy,
  onClose,
  onPick,
  onUpload,
  onToggleLike,
}: Props) {
  const [tab, setTab] = useState<AssetTab>("uploads");
  const [sort, setSort] = useState<AssetSort>("recent");
  const [working, setWorking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<File | null>(null);
  const [error, setError] = useState<string>();

  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const disabled = Boolean(busy) || working;
  const shown = useMemo(
    () => pickAssets({ uploads, renders, liked }, kind, tab, sort),
    [uploads, renders, liked, kind, tab, sort],
  );
  const empty =
    tab === "generations"
      ? kind === "video"
        ? "No clips yet. Generate a clip to reuse it here."
        : "No stills yet. Generate an image to reuse it here."
      : "Nothing in Saved yet. Star an asset and it will wait here.";
  // Nothing in this app renders an audio file, so that slot has no Output tab.
  // A video slot gains the bundled Samples tab: clips to try before uploading.
  const tabs =
    kind === "audio"
      ? ASSET_TABS.filter((item) => item.id !== "generations")
      : kind === "video"
        ? [...ASSET_TABS, SAMPLES_TAB]
        : ASSET_TABS;

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // The editor owns Escape while it is open.
      if (event.key === "Escape" && !editing) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, onClose]);

  async function commitUpload(file: File, seconds?: number) {
    setWorking(true);
    setError(undefined);
    try {
      const id = `upload:${crypto.randomUUID()}`;
      const name = file.name || `upload.${kind === "image" ? "jpg" : kind === "audio" ? "mp3" : "mp4"}`;

      if (kind === "image") {
        const reference = await prepareReference(file);
        const asset: Asset = { id, kind, origin: "upload", name, src: await saveUpload(file), createdAt: Date.now() };
        onUpload(asset);
        onPick({ kind: "image", asset, reference });
      } else {
        const media = await prepareMedia(file, MAX_MEDIA_MB, seconds);
        const length = media.seconds && Number.isFinite(media.seconds) ? Math.round(media.seconds) : undefined;
        // Stored, not object-URL'd: the library has to survive a reload.
        const asset: Asset = {
          id,
          kind,
          origin: "upload",
          name,
          src: await saveUpload(file),
          createdAt: Date.now(),
          ...(kind === "video" && length ? { seconds: length } : {}),
        };
        onUpload(asset);
        onPick({ kind, asset, media });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read that file.");
    } finally {
      setWorking(false);
    }
  }

  async function upload(file: File) {
    if (disabled) return;
    if (!fitsKind(file, kind)) {
      setError(kindError(kind));
      return;
    }

    // A clip gets a trim/crop pass first; stills and tracks go straight in.
    if (kind === "video") {
      setError(undefined);
      setEditing(file);
      return;
    }

    await commitUpload(file);
  }

  async function choose(asset: Asset) {
    if (disabled || asset.kind !== kind) return;

    setWorking(true);
    setError(undefined);
    try {
      if (asset.kind === "image") {
        const reference = await referenceFromSrc(asset.src, asset.name);
        onPick({ kind: "image", asset, reference });
      } else {
        const media = await mediaFromSrc(asset.src, asset.name, MAX_MEDIA_MB, asset.seconds);
        onPick({ kind: asset.kind, asset, media });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read that asset.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <div className="overlay asset-overlay" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div
        ref={panelRef}
        className={`modal asset-panel${dragging ? " is-dragging" : ""}`}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          const file = event.dataTransfer.files?.[0];
          if (file) void upload(file);
        }}
      >
        <div className="asset-top">
          <div className="asset-tabs" role="tablist" aria-label="Asset source">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={tab === item.id ? "is-active" : ""}
                onClick={() => setTab(item.id)}
                disabled={disabled}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button type="button" className="asset-close" aria-label="Close assets picker" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="asset-toolbar">
          <div className="asset-sort" role="group" aria-label="Sort assets">
            <button
              type="button"
              className={sort === "recent" ? "is-active" : ""}
              aria-pressed={sort === "recent"}
              onClick={() => setSort("recent")}
              disabled={disabled}
            >
              Recent
            </button>
            <button
              type="button"
              className={sort === "all" ? "is-active" : ""}
              aria-pressed={sort === "all"}
              onClick={() => setSort("all")}
              disabled={disabled}
            >
              All
            </button>
          </div>
        </div>

        <div className="asset-body">
          {tab === "uploads" && (
            <button
              type="button"
              className="asset-upload"
              onClick={() => inputRef.current?.click()}
              disabled={disabled}
            >
              <span className="asset-upload-icon" aria-hidden="true">
                <CloudIcon />
              </span>
              <span>{working ? "Reading…" : "Upload media"}</span>
            </button>
          )}

          {shown.map((asset) => {
            const isLiked = liked.includes(asset.id);
            const isSample = asset.origin === "sample";
            return (
              <AssetTile
                key={asset.id}
                asset={asset}
                liked={isLiked}
                disabled={disabled}
                onOpen={() => void choose(asset)}
                {...(isSample ? {} : { onToggleLike: () => onToggleLike(asset.id) })}
              />
            );
          })}

          {shown.length === 0 && tab !== "uploads" && <p className="asset-empty">{empty}</p>}
        </div>

        {error && (
          <p className="asset-error" role="alert">
            {error}
          </p>
        )}

        <input
          ref={inputRef}
          type="file"
          accept={acceptFor(kind)}
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void upload(file);
          }}
        />
        </div>
      </div>

      {editing && (
        <VideoEditModal
          file={editing}
          onCancel={() => setEditing(null)}
          onApply={(edited, seconds) => {
            setEditing(null);
            void commitUpload(edited, seconds);
          }}
        />
      )}
    </>
  );
}
