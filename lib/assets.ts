/**
 * The asset picker's model.
 *
 * Reference slots used to open the OS file dialog straight away. The picker
 * sits between a slot and the filesystem: everything already uploaded in this
 * session plus everything the project has rendered, filtered to the kind of
 * media the slot can actually take.
 *
 * Keeping that filtering, ordering and the caps here makes it testable; the
 * component only paints what this module returns.
 *
 * Files this module sees are validated again on the server, so it stays free of
 * Node/browser APIs and can run under `node --test`.
 */

export type AssetKind = "image" | "audio" | "video";
export type AssetOrigin = "upload" | "render" | "sample";
export type AssetTab = "uploads" | "generations" | "liked" | "samples";
export type AssetSort = "recent" | "all";

export type Asset = {
  id: string;
  kind: AssetKind;
  origin: AssetOrigin;
  /** Shown on the tile and used as the reference's file name. */
  name: string;
  /** What the picker previews and re-reads when the tile is chosen. */
  src: string;
  /** When it entered the library; "Recent" is ordered by this. */
  createdAt: number;
  /** Whole seconds, for clips. */
  seconds?: number;
  /** The prompt the person typed, used as the tile's tooltip and the viewer's headline. */
  note?: string;
  /** What the model was actually given, when it differs from `note`. */
  detail?: string;
};

/** One project frame, as far as this module cares. */
export type RenderLike = {
  id: string;
  src: string;
  /** What the model was given: a still's rewrite, or a clip's six-section brief. */
  prompt?: string;
  /** What the person typed, before any enhancement. */
  sourcePrompt?: string;
  seconds?: number;
  createdAt: number;
  media?: "image" | "video";
};

export const ASSET_TABS: readonly { id: AssetTab; label: string }[] = [
  { id: "uploads", label: "Uploads" },
  { id: "generations", label: "Output" },
  { id: "liked", label: "Saved" },
];

/**
 * Every kind the library holds, in the order the Assets tab lists them. A
 * slot's picker only ever asks about one of these; the library shows all.
 */
export const ASSET_KINDS: readonly AssetKind[] = ["image", "video", "audio"];

/**
 * The Assets tab's filter: "recent" is the whole library newest-first, and a
 * kind narrows it to one row. There is no cap and no "all" — Recent is the
 * everything view.
 */
export type LibraryFilter = "recent" | AssetKind;

export const LIBRARY_FILTERS: readonly { id: LibraryFilter; label: string }[] = [
  { id: "recent", label: "Recent" },
  { id: "image", label: "Images" },
  { id: "video", label: "Videos" },
  { id: "audio", label: "Audio" },
];

/**
 * The picker's extra tab for the bundled clips. The Assets tab never shows it:
 * samples are not library entries, they are a starting point for a video slot.
 */
export const SAMPLES_TAB: { readonly id: AssetTab; readonly label: string } = { id: "samples", label: "Samples" };

/**
 * The sample clips, hosted on GitHub rather than bundled with the app.
 *
 * They exist so a video slot has something real to try before anything has
 * been uploaded. Nothing is copied into the library: picking one reads the
 * file straight off the origin, the same way a render is reused. The base
 * points at the `samples/` folder of the app's repository — move the clips
 * (or point at a release) by changing this one constant.
 */
const SAMPLES_BASE = "https://raw.githubusercontent.com/nova452/Comfy-Cinematic/main/samples";

export const SAMPLE_CLIPS: readonly Asset[] = [
  { id: "sample:1", kind: "video", origin: "sample", name: "Sample 1", src: `${SAMPLES_BASE}/sample-1.mp4`, createdAt: 0 },
  { id: "sample:2", kind: "video", origin: "sample", name: "Sample 2", src: `${SAMPLES_BASE}/sample-2.mp4`, createdAt: 0 },
  { id: "sample:3", kind: "video", origin: "sample", name: "Sample 3", src: `${SAMPLES_BASE}/sample-3.mp4`, createdAt: 0 },
  { id: "sample:4", kind: "video", origin: "sample", name: "Sample 4", src: `${SAMPLES_BASE}/sample-4.mp4`, createdAt: 0 },
];

/**
 * The pills the Assets tab offers for a given source.
 *
 * Nothing in this app renders audio, so Output has no Audio pill — an empty
 * shelf behind a filter that can never fill is just a dead end.
 */
export function libraryFilters(tab: AssetTab): readonly { id: LibraryFilter; label: string }[] {
  return tab === "generations" ? LIBRARY_FILTERS.filter((item) => item.id !== "audio") : LIBRARY_FILTERS;
}

/** "Recent" is the newest slice of the library, not a separate collection. */
export const RECENT_LIMIT = 8;

/** Uploads live in memory for the session; keep the list to something sane. */
export const MAX_UPLOADS = 24;

const EXTENSION_KIND: Record<string, AssetKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  avif: "image",
  gif: "image",
  bmp: "image",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  aac: "audio",
  ogg: "audio",
  flac: "audio",
  mp4: "video",
  webm: "video",
  mov: "video",
  m4v: "video",
};

const ACCEPT: Record<AssetKind, string> = {
  image: "image/png,image/jpeg,image/webp",
  audio: "audio/mpeg,audio/wav,audio/mp4",
  video: "video/mp4,video/webm",
};

/** What the API and the models behind it reliably accept. */
const ALLOWED_MIME: Record<AssetKind, RegExp> = {
  image: /^image\/(png|jpe?g|webp)$/i,
  audio: /^audio\/(mpeg|mp3|wav|x-wav|wave|mp4|m4a|x-m4a|aac)$/i,
  video: /^video\/(mp4|webm)$/i,
};

/** What a slot of this kind should offer to the file dialog. */
export function acceptFor(kind: AssetKind) {
  return ACCEPT[kind];
}

function extensionOf(name?: string) {
  const value = (name ?? "").toLowerCase();
  return value.includes(".") ? value.slice(value.lastIndexOf(".") + 1) : "";
}

/**
 * The content types uploads are stored under, keyed by extension.
 *
 * Only what `ALLOWED_MIME` lets through: the store derives the file extension
 * and the served type from these, so this list and the gate have to agree.
 */
const STORE_TYPE: Record<string, string> = {
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

/**
 * What the upload route should label a picked file with.
 *
 * The MIME type wins when it is one this app stores; otherwise the extension
 * decides — the same order `fitsKind` reads them in.
 */
export function uploadType(file: { type?: string; name?: string }) {
  const type = (file.type ?? "").toLowerCase().split(";")[0]!.trim();
  if (Object.values(STORE_TYPE).includes(type)) return type;
  return STORE_TYPE[extensionOf(file.name)];
}

/**
 * The `accept` attribute only filters the dialog; drag and drop ignores it.
 * This is the actual gate, so the two never disagree.
 */
export function fitsKind(file: { type?: string; name?: string }, kind: AssetKind): boolean {
  const type = (file.type ?? "").toLowerCase();
  // An empty or generic type is common for drag-and-drop and renamed files.
  if (type && type !== "application/octet-stream") return ALLOWED_MIME[kind].test(type);
  return EXTENSION_KIND[extensionOf(file.name)] === kind;
}

/**
 * Classify a picked file. Browsers sometimes leave `type` empty (and people
 * rename files), so the extension is the fallback rather than the rule.
 */
export function assetKindFrom(file: { type?: string; name?: string }): AssetKind | undefined {
  const type = (file.type ?? "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";

  return EXTENSION_KIND[extensionOf(file.name)];
}

/**
 * True when the sent prompt says nothing more than the typed one did.
 *
 * The provider sometimes only tidies the text — a capital and a full stop —
 * and a fold that reads "Prompt sent: A lone pigeon." under "A lone pigeon"
 * is noise, not information.
 */
function samePrompt(sent: string, typed: string) {
  const key = (value: string) =>
    value
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[.!…]+$/, "")
      .trim();
  return key(sent) === key(typed);
}

/** A project frame folded into a pickable asset. */
export function renderAsset(frame: RenderLike, index: number): Asset {
  const clip = frame.media === "video" || /\.(mp4|webm)$/i.test(frame.src);
  const ordinal = String(index + 1).padStart(2, "0");
  // The person's own words are the headline. `frame.prompt` is what the model
  // was handed — for a clip that is a six-section brief, not a prompt — so it
  // rides along separately and is folded away in the viewer.
  const typed = frame.sourcePrompt?.trim() ?? "";
  const sent = frame.prompt?.trim() ?? "";

  return {
    id: `render:${frame.id}`,
    kind: clip ? "video" : "image",
    origin: "render",
    name: clip ? `Clip ${ordinal}` : `Still ${ordinal}`,
    src: frame.src,
    createdAt: frame.createdAt,
    ...(clip && frame.seconds ? { seconds: frame.seconds } : {}),
    ...(typed ? { note: typed } : {}),
    ...(sent && !samePrompt(sent, typed) ? { detail: sent } : {}),
  };
}

export type AssetLibrary = {
  uploads: Asset[];
  renders: Asset[];
  liked: string[];
};

/** The assets one source tab draws from. */
function poolFor(library: AssetLibrary, tab: AssetTab): Asset[] {
  if (tab === "uploads") return library.uploads;
  if (tab === "generations") return library.renders;
  return [...library.uploads, ...library.renders];
}

/** Newest first; the id breaks ties so the grid is stable. */
function newestFirst(a: Asset, b: Asset) {
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

/**
 * What the grid shows for the current tab, kind and sort. A slot only ever
 * takes its own kind, so a first frame never offers a clip and an audio bed
 * never offers a JPEG.
 */
export function pickAssets(library: AssetLibrary, kind: AssetKind, tab: AssetTab, sort: AssetSort): Asset[] {
  // Samples are not library entries, so they never reach the pools below.
  if (tab === "samples") return kind === "video" ? [...SAMPLE_CLIPS] : [];
  const liked = new Set(library.liked);
  const matches = poolFor(library, tab)
    .filter((asset) => asset.kind === kind)
    .filter((asset) => tab !== "liked" || liked.has(asset.id))
    .sort(newestFirst);

  return sort === "recent" ? matches.slice(0, RECENT_LIMIT) : matches;
}

/**
 * The Assets tab's grid: one flat list, newest first, of everything or of one
 * kind.
 *
 * Nothing is grouped — the kind badge on each tile says what it is — and
 * nothing is capped, because this is the whole library rather than a slot's
 * shortlist.
 */
export function pickLibrary(library: AssetLibrary, tab: AssetTab, filter: LibraryFilter): Asset[] {
  const liked = new Set(library.liked);
  return poolFor(library, tab)
    .filter((asset) => filter === "recent" || asset.kind === filter)
    .filter((asset) => tab !== "liked" || liked.has(asset.id))
    .sort(newestFirst);
}

/** Newest upload first, without duplicates, capped for the session. */
export function addUpload(uploads: Asset[], asset: Asset): Asset[] {
  return [asset, ...uploads.filter((item) => item.id !== asset.id)].slice(0, MAX_UPLOADS);
}

/** Star / unstar an asset. Ids are prefixed (`render:` or `upload:`). */
export function toggleLiked(liked: string[], id: string): string[] {
  return liked.includes(id) ? liked.filter((item) => item !== id) : [id, ...liked].slice(0, 200);
}
