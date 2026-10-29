/**
 * The browser's media store: every still, clip and track the app produces or
 * the person uploads.
 *
 * A source is `media:<uuid>.<ext>` — the same shape wherever a frame, an asset
 * or a reference slot wants one — and resolves to an object URL for the page.
 * Nothing is sent to the server to be kept.
 */

import { useEffect, useState } from "react";
import { deleteRecord, getRecord, MEDIA_STORE, putRecord, requestPersistence } from "./browser-db.ts";

const PREFIX = "media:";

/** 1×1 transparent GIF: what a tile shows while its blob is being read. */
const PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
};

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
};

type MediaRecord = {
  id: string;
  blob: Blob;
  name?: string;
  createdAt: number;
};

/** Object URLs by id, and the ids being read right now. */
const urls = new Map<string, string>();
const loading = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function announce() {
  version += 1;
  for (const listener of listeners) listener();
}

export function isMediaSrc(src: string | undefined) {
  return typeof src === "string" && src.startsWith(PREFIX);
}

function idOf(src: string) {
  return src.slice(PREFIX.length);
}

function extensionOf(type: string, name?: string) {
  const byType = EXTENSIONS[type.split(";", 1)[0]?.trim().toLowerCase() ?? ""];
  if (byType) return byType;
  const fromName = name?.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return fromName && TYPES[fromName] ? fromName : "png";
}

export function typeOf(src: string, fallback = "application/octet-stream") {
  const extension = src.split(".").pop()?.toLowerCase() ?? "";
  return TYPES[extension] ?? fallback;
}

/** Keep a blob and return the `media:` source that points at it. */
export async function putMedia(blob: Blob, name?: string): Promise<string> {
  const id = `${crypto.randomUUID()}.${extensionOf(blob.type, name)}`;
  const record: MediaRecord = { id, blob, ...(name ? { name } : {}), createdAt: Date.now() };
  await putRecord(MEDIA_STORE, record);
  requestPersistence();
  return `${PREFIX}${id}`;
}

/** Keep the bytes behind a data URL — what the render routes answer with. */
export async function putDataUrl(dataUrl: string, name?: string): Promise<string> {
  const [header = "", body = ""] = dataUrl.split(",", 2);
  const type = header.slice(header.indexOf(":") + 1, header.indexOf(";")) || "image/png";
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return putMedia(new Blob([bytes], { type }), name);
}

/** Keep a bare base64 JPEG ? the shape the panel holds for a reference. */
export function putJpeg(base64: string, name = "reference.jpg") {
  return putDataUrl(`data:image/jpeg;base64,${base64}`, name);
}

async function read(src: string): Promise<Blob | undefined> {
  if (isMediaSrc(src)) {
    try {
      return (await getRecord<MediaRecord>(MEDIA_STORE, idOf(src)))?.blob;
    } catch {
      return undefined;
    }
  }
  if (src.startsWith("data:")) {
    const response = await fetch(src);
    return response.ok ? response.blob() : undefined;
  }
  try {
    const response = await fetch(src, { cache: "force-cache" });
    return response.ok ? await response.blob() : undefined;
  } catch {
    return undefined;
  }
}

/** A source's bytes, whichever shape it is stored in. */
export function getMediaBlob(src: string) {
  return read(src);
}

/**
 * The URL a `media:` source resolves to, for an `<img>` or `<video>`.
 *
 * The first call starts the read and returns a placeholder; the blob lands a
 * tick later and `useMediaVersion` re-renders the tree that asked.
 */
export function mediaUrl(src: string | undefined): string {
  if (!src) return PLACEHOLDER;
  if (!isMediaSrc(src)) return src;

  const id = idOf(src);
  const ready = urls.get(id);
  if (ready) return ready;
  if (loading.has(id)) return PLACEHOLDER;

  loading.add(id);
  void getRecord<MediaRecord>(MEDIA_STORE, id)
    .then((record) => {
      if (!record) return;
      urls.set(id, URL.createObjectURL(record.blob));
      announce();
    })
    .catch(() => undefined)
    .finally(() => loading.delete(id));

  return PLACEHOLDER;
}

/** Forget a source's bytes, and the URL that was serving them. */
export async function deleteMedia(sources: (string | undefined)[]) {
  await Promise.all(
    sources.map(async (source) => {
      if (!isMediaSrc(source)) return;
      const id = idOf(source!);
      const url = urls.get(id);
      if (url) {
        URL.revokeObjectURL(url);
        urls.delete(id);
      }
      await deleteRecord(MEDIA_STORE, id).catch(() => undefined);
    }),
  );
}

/** Re-render whenever a blob lands, so tiles fill in as they load. */
export function useMediaVersion() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((tick) => tick + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return version;
}
