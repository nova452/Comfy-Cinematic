/**
 * Live progress of the renders this server is running, keyed by the id the
 * canvas gave the render's tile.
 *
 * A local clip takes minutes and its request only answers at the end, so the
 * route writes each stage here and `/api/video/progress` reads it back while
 * the tile waits. In memory on purpose: progress is only worth anything while
 * the request that owns it is alive, and a restart loses both together. The
 * map hangs off `globalThis` because Next can load a module once per route in
 * development, and the two routes have to share one copy.
 */

export type RenderStage =
  | "starting"
  | "rewriting"
  | "uploading"
  | "queued"
  | "running"
  | "downloading"
  /** The request answered; `/api/video/result` holds what it said. */
  | "done"
  | "failed";

export type RenderProgress = {
  stage: RenderStage;
  /** Sampler step, while the graph is sampling. */
  step?: number;
  steps?: number;
  /** Where the job sits in the target's queue, while it waits. */
  queuePosition?: number;
  /** The node class running now, e.g. `SamplerCustomAdvanced`. */
  node?: string;
  /** Whole-graph fraction, 0–1, as the target reports it. */
  value?: number;
  /** Why a failed render failed, in the route's own words. */
  error?: string;
  startedAt: number;
  updatedAt: number;
};

/** A render nobody has asked about for this long is forgotten. */
const STALE_MS = 30 * 60_000;

const shared = globalThis as typeof globalThis & {
  __renderProgress?: Map<string, RenderProgress>;
  __renderOutcomes?: Map<string, unknown>;
};
const store = (shared.__renderProgress ??= new Map());
/**
 * What a finished render answered, kept so a page that reloaded mid-render
 * can still collect its clip. Dropped when collected or when its progress
 * record goes stale.
 */
const outcomes = (shared.__renderOutcomes ??= new Map());

/** A tile id the client may name: a UUID, nothing that could be a path. */
export function isRenderId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{8,64}$/i.test(value);
}

/** Merge a stage update into a render's record, starting it if it is new. */
export function reportProgress(id: string | undefined, update: Partial<RenderProgress> & { stage: RenderStage }) {
  if (!id) return;
  const now = Date.now();
  const previous = store.get(id);
  // A new stage clears the last one's numbers, so "queued #2" never shows a step.
  const carried = previous && previous.stage === update.stage ? previous : undefined;
  store.set(id, { ...carried, ...update, startedAt: previous?.startedAt ?? now, updatedAt: now });

  for (const [key, entry] of store) {
    if (now - entry.updatedAt > STALE_MS) {
      store.delete(key);
      outcomes.delete(key);
    }
  }
}

/** Record a render's answer: a successful body is held for collection. */
export function finishProgress(id: string | undefined, ok: boolean, body: unknown) {
  if (!id) return;
  if (ok) {
    outcomes.set(id, body);
    reportProgress(id, { stage: "done" });
    return;
  }
  const error =
    body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : "The clip could not be rendered.";
  reportProgress(id, { stage: "failed", error });
}

/** Hand over a finished render's body once, then forget the render. */
export function takeOutcome(id: string) {
  const body = outcomes.get(id);
  outcomes.delete(id);
  store.delete(id);
  return body;
}

export function readProgress(id: string) {
  return store.get(id);
}

export function clearProgress(id: string | undefined) {
  if (!id) return;
  store.delete(id);
  outcomes.delete(id);
}

/** What a tile says for a record: short enough for a 200px square. */
export function progressLabel(progress: Pick<RenderProgress, "stage" | "step" | "steps" | "queuePosition" | "node">) {
  switch (progress.stage) {
    case "starting":
      return "Starting…";
    case "done":
      return "Finishing…";
    case "failed":
      return "Failed";
    case "rewriting":
      return "Reading the reference…";
    case "uploading":
      return "Uploading references…";
    case "queued":
      return progress.queuePosition ? `Queued · #${progress.queuePosition}` : "Queued…";
    case "downloading":
      return "Fetching the clip…";
    case "running":
      if (progress.step && progress.steps) return `Sampling ${progress.step}/${progress.steps}`;
      if (progress.node && /decode/i.test(progress.node)) return "Decoding…";
      return "Rendering…";
  }
}
