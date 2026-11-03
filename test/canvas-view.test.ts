import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  canvasViewKey,
  fitView,
  normalizeView,
  readCanvasView,
  recenter,
  toScreen,
  toWorld,
  writeCanvasView,
  zoomAt,
  type View,
  type ViewStore,
} from "../lib/canvas-view.ts";

const PROJECT = "216220da-39bf-45c4-8434-133af982e28b";

/** The desktop area `fit` uses: the left rail and the top strip are chrome. */
const DESKTOP = { x: 372, y: 76, width: 1044, height: 736 };
const PADDING = 48;

type MemoryStore = ViewStore & { entries: Map<string, string> };

function memoryStore(initial: Record<string, string> = {}): MemoryStore {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

function close(actual: number, expected: number, message?: string) {
  assert.ok(Math.abs(actual - expected) < 1e-6, message ?? `${actual} is not ${expected}`);
}

test("a view maps board points to screen points and back", () => {
  const view: View = { x: 40, y: -20, zoom: 0.5 };

  assert.deepEqual(toScreen(view, 100, 200), { x: 90, y: 80 });
  assert.deepEqual(toWorld(view, 90, 80), { x: 100, y: 200 });
});

test("zooming keeps the board point under the cursor", () => {
  const view: View = { x: 100, y: 50, zoom: 0.5 };
  const cursor = { x: 300, y: 200 };
  const world = toWorld(view, cursor.x, cursor.y);

  const zoomed = zoomAt(view, 1.4, cursor);
  const after = toScreen(zoomed, world.x, world.y);

  assert.ok(zoomed.zoom > view.zoom);
  close(after.x, cursor.x);
  close(after.y, cursor.y);
});

test("zooming out keeps the board point under the cursor too", () => {
  const view: View = { x: -120, y: 36, zoom: 1.5 };
  const cursor = { x: 640, y: 410 };
  const world = toWorld(view, cursor.x, cursor.y);

  const zoomed = zoomAt(view, 0.6, cursor);
  const after = toScreen(zoomed, world.x, world.y);

  close(after.x, cursor.x);
  close(after.y, cursor.y);
});

test("zooming stops at the range instead of running past it", () => {
  const cursor = { x: 200, y: 200 };
  const atMax: View = { x: 0, y: 0, zoom: MAX_ZOOM };
  const atMin: View = { x: 0, y: 0, zoom: MIN_ZOOM };

  assert.equal(zoomAt(atMax, 2, cursor), atMax);
  assert.equal(zoomAt(atMin, 0.5, cursor), atMin);
  assert.equal(zoomAt({ x: 0, y: 0, zoom: 1 }, 100, cursor).zoom, MAX_ZOOM);
  assert.equal(zoomAt({ x: 0, y: 0, zoom: 1 }, 0.0001, cursor).zoom, MIN_ZOOM);
});

test("a zoom that lands on 100% snaps to it", () => {
  const view: View = { x: 10, y: 20, zoom: 0.99 };
  const zoomed = zoomAt(view, 1.005, { x: 0, y: 0 });

  assert.equal(zoomed.zoom, 1);
});

test("a zoom factor that is not a positive number leaves the view alone", () => {
  const view: View = { x: 10, y: 20, zoom: 1 };
  assert.equal(zoomAt(view, 0, { x: 0, y: 0 }), view);
  assert.equal(zoomAt(view, -2, { x: 0, y: 0 }), view);
  assert.equal(zoomAt(view, Number.NaN, { x: 0, y: 0 }), view);
});

test("fitting centres a lone tile in the usable area at its own size", () => {
  const fitted = fitView({ x: 0, y: 0, width: 512, height: 512 }, DESKTOP, PADDING);

  assert.equal(fitted.zoom, 1);
  // The tile's middle is the middle of the box.
  close(fitted.x + 256, DESKTOP.x + DESKTOP.width / 2);
  close(fitted.y + 256, DESKTOP.y + DESKTOP.height / 2);
});

test("fitting frames the board wherever it sits, not the origin", () => {
  const bounds = { x: 2000, y: 1200, width: 512, height: 512 };
  const fitted = fitView(bounds, DESKTOP, PADDING);
  const middle = toScreen(fitted, bounds.x + 256, bounds.y + 256);

  close(middle.x, DESKTOP.x + DESKTOP.width / 2);
  close(middle.y, DESKTOP.y + DESKTOP.height / 2);
});

test("fitting a wide grid shrinks it inside the padding", () => {
  const bounds = { x: 0, y: 0, width: 1600, height: 512 };
  const fitted = fitView(bounds, DESKTOP, PADDING);

  assert.ok(fitted.zoom < 1);
  const left = toScreen(fitted, bounds.x, bounds.y).x;
  const top = toScreen(fitted, bounds.x, bounds.y).y;
  const right = toScreen(fitted, bounds.x + bounds.width, bounds.y + bounds.height).x;
  const bottom = toScreen(fitted, bounds.x + bounds.width, bounds.y + bounds.height).y;

  assert.ok(left >= DESKTOP.x + PADDING - 1e-6);
  assert.ok(top >= DESKTOP.y + PADDING - 1e-6);
  assert.ok(right <= DESKTOP.x + DESKTOP.width - PADDING + 1e-6);
  assert.ok(bottom <= DESKTOP.y + DESKTOP.height - PADDING + 1e-6);
  // And it is centred, not pinned to a corner.
  close((left + right) / 2, DESKTOP.x + DESKTOP.width / 2);
  close((top + bottom) / 2, DESKTOP.y + DESKTOP.height / 2);
});

test("fitting never grows a small board past 100%", () => {
  const fitted = fitView({ x: 0, y: 0, width: 64, height: 64 }, DESKTOP, PADDING);
  assert.equal(fitted.zoom, 1);
});

test("fitting a board too big for any zoom stops at the minimum", () => {
  const fitted = fitView({ x: 0, y: 0, width: 100_000, height: 100_000 }, DESKTOP, PADDING);
  assert.equal(fitted.zoom, MIN_ZOOM);
});

test("recentring holds the board point in the middle of the usable area", () => {
  const view: View = { x: 30, y: -60, zoom: 0.8 };
  const from = { x: 0, y: 0, width: 800, height: 600 };
  const to = { x: 372, y: 76, width: 1000, height: 700 };
  const middle = toWorld(view, from.x + from.width / 2, from.y + from.height / 2);

  const moved = recenter(view, from, to);
  const after = toScreen(moved, middle.x, middle.y);

  assert.equal(moved.zoom, view.zoom);
  close(after.x, to.x + to.width / 2);
  close(after.y, to.y + to.height / 2);
});

test("recentring an unchanged box leaves the view alone", () => {
  const view: View = { x: 12, y: 34, zoom: 1 };
  assert.equal(recenter(view, DESKTOP, DESKTOP), view);
});

test("a stored view must be three finite numbers", () => {
  assert.deepEqual(normalizeView({ x: 12, y: -34, zoom: 0.5 }), { x: 12, y: -34, zoom: 0.5 });
  assert.equal(normalizeView(null), null);
  assert.equal(normalizeView([]), null);
  assert.equal(normalizeView("view"), null);
  assert.equal(normalizeView({ x: 0, y: 0 }), null);
  assert.equal(normalizeView({ x: 0, y: 0, zoom: 0 }), null);
  assert.equal(normalizeView({ x: 0, y: 0, zoom: -1 }), null);
  assert.equal(normalizeView({ x: Number.NaN, y: 0, zoom: 1 }), null);
  assert.equal(normalizeView({ x: 0, y: Number.POSITIVE_INFINITY, zoom: 1 }), null);
});

test("a stored zoom outside the range is clamped into it", () => {
  assert.equal(normalizeView({ x: 0, y: 0, zoom: 100 })?.zoom, MAX_ZOOM);
  assert.equal(normalizeView({ x: 0, y: 0, zoom: 0.0001 })?.zoom, MIN_ZOOM);
});

test("the view key is per project", () => {
  assert.equal(canvasViewKey(PROJECT), `cinematic.view.${PROJECT}`);
  assert.notEqual(canvasViewKey("a"), canvasViewKey("b"));
});

test("a stored view round-trips", () => {
  const store = memoryStore();
  const view: View = { x: -412.5, y: 88, zoom: 0.64 };

  writeCanvasView(store, PROJECT, view);

  assert.deepEqual(readCanvasView(store, PROJECT), view);
  assert.ok(store.entries.has(canvasViewKey(PROJECT)));
  // Another project is untouched.
  assert.equal(readCanvasView(store, "11111111-1111-1111-1111-111111111111"), null);
});

test("a corrupt stored view is ignored rather than restored", () => {
  const store = memoryStore({ [canvasViewKey(PROJECT)]: "{not json" });
  assert.equal(readCanvasView(store, PROJECT), null);

  store.entries.set(canvasViewKey(PROJECT), JSON.stringify({ x: "left", y: 0, zoom: 1 }));
  assert.equal(readCanvasView(store, PROJECT), null);
});

test("a store that refuses to write does not break the canvas", () => {
  const store: ViewStore = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
  };

  assert.doesNotThrow(() => writeCanvasView(store, PROJECT, { x: 0, y: 0, zoom: 1 }));
});
