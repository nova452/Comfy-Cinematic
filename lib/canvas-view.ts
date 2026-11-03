/**
 * The canvas viewport: where the board sits, and how big it looks.
 *
 * Modelled on ComfyUI's `DragAndScale` — an offset and a scale, with a world
 * point landing at `world * zoom + offset` — because that is the pair the
 * canvas has to remember. ComfyUI stores it beside the workflow (`extra.ds`)
 * and reopens a graph exactly where it was left; this does the same per
 * project, so a reload never re-frames the board by itself.
 *
 * Kept pure and storage-agnostic — reading is a `getItem`, writing is a
 * `setItem` — so the fit/zoom arithmetic and what a stored view may contain
 * are unit tested instead of discovered on reload.
 */

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 2;

/** A point in canvas pixels (what the screen shows). */
export type Point = { x: number; y: number };

/** Where the board sits on screen, and how big it looks. */
export type View = { x: number; y: number; zoom: number };

/** A rectangle in canvas pixels: the part of the canvas a person can see. */
export type Box = { x: number; y: number; width: number; height: number };

/** A rectangle in board coordinates: what a fit has to frame. */
export type Bounds = { x: number; y: number; width: number; height: number };

/** Anything that holds strings by key — `window.localStorage` qualifies. */
export type ViewStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function clampZoom(zoom: number) {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Where a board point lands on screen.
 *
 * The same mapping the canvas applies with `translate()` then `scale()`, and
 * the inverse of `toWorld`.
 */
export function toScreen(view: View, x: number, y: number): Point {
  return { x: x * view.zoom + view.x, y: y * view.zoom + view.y };
}

/** The board point under a screen point. */
export function toWorld(view: View, x: number, y: number): Point {
  return { x: (x - view.x) / view.zoom, y: (y - view.y) / view.zoom };
}

/**
 * Zoom about a point on screen, so the board under it stays put.
 *
 * A wheel over a tile should grow that tile in place, not slide the board
 * around under the cursor. ComfyUI's `changeScale` does the same, and snaps
 * to 100% within a hair so the natural size is easy to land on.
 */
export function zoomAt(view: View, factor: number, point: Point): View {
  if (!Number.isFinite(factor) || factor <= 0) return view;

  const scaled = clampZoom(view.zoom * factor);
  const zoom = Math.abs(scaled - 1) < 0.01 ? 1 : scaled;
  if (zoom === view.zoom) return view;

  const scale = zoom / view.zoom;
  return {
    zoom,
    x: point.x - (point.x - view.x) * scale,
    y: point.y - (point.y - view.y) * scale,
  };
}

/**
 * Frame a board inside a box.
 *
 * The board is centred in the box and shrunk until it fits, but never grown
 * past 100%: a single 512px tile should read at its own size rather than be
 * blown up to fill a wide monitor. An empty board is framed as the square the
 * first result will fill, so that first tile lands in the middle of the space
 * instead of below and to the right of it.
 */
export function fitView(bounds: Bounds, box: Box, padding = 0): View {
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  const roomX = Math.max(1, box.width - padding * 2);
  const roomY = Math.max(1, box.height - padding * 2);
  const zoom = clampZoom(Math.min(1, roomX / width, roomY / height));

  return {
    zoom,
    x: box.x + box.width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: box.y + box.height / 2 - (bounds.y + bounds.height / 2) * zoom,
  };
}

/**
 * Keep the board point in the middle of the usable area when that area moves.
 *
 * A window resize, a phone keyboard, a rotating tablet: the canvas changes
 * size without the person asking, and re-fitting here would throw away their
 * pan and zoom. Holding the middle still is what keeps the work where they
 * left it.
 */
export function recenter(view: View, from: Box, to: Box): View {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (dx === 0 && dy === 0) return view;
  return { ...view, x: view.x + dx, y: view.y + dy };
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A stored view, field by field.
 *
 * Positions are not bounded — the board can sit anywhere, including far to
 * the left of the origin — but a zoom that is not a positive number is not a
 * view at all, and one outside the range is clamped into it. `null` means the
 * caller should fit instead of restoring.
 */
export function normalizeView(raw: unknown): View | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!isNumber(value.x) || !isNumber(value.y) || !isNumber(value.zoom) || value.zoom <= 0) return null;

  return { x: value.x, y: value.y, zoom: clampZoom(value.zoom) };
}

/** One key per project, so two canvases remember different views. */
export function canvasViewKey(projectId: string) {
  return `cinematic.view.${projectId}`;
}

/** One project's view, or null when nothing usable was stored. */
export function readCanvasView(store: ViewStore, projectId: string): View | null {
  try {
    const raw = store.getItem(canvasViewKey(projectId));
    if (!raw) return null;
    return normalizeView(JSON.parse(raw));
  } catch {
    // Unreadable JSON, a blocked store: the canvas fits as if this were new.
    return null;
  }
}

/** Store a view, tolerating a full, disabled or absent store. */
export function writeCanvasView(store: ViewStore, projectId: string, view: View) {
  try {
    store.setItem(canvasViewKey(projectId), JSON.stringify(view));
  } catch {
    // Only the next reload is affected; the canvas still works now.
  }
}
