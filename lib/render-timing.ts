/**
 * Where a local render's time went.
 *
 * Built from the progress reports the runner already makes: each report names
 * a stage (uploading, queued, running, downloading) and, on a deployment, the
 * class of the node that is running. A segment closes whenever that changes,
 * so the breakdown is only as fine as the job polling (every 2.5 s): a node
 * quicker than a poll is counted in its neighbour's time.
 *
 * Pure and dependency-free, so the route can send segments and the panel can
 * format them.
 */

export type TimingSegment = { stage: string; ms: number };

/** What a progress report carries that the timer reads. */
type Report = { stage: string; node?: string };

/** Node classes grouped into the stages a person would name. */
const NODE_STAGES: [RegExp, string][] = [
  [/^(OpenRouterStructuredOutput|GeminiNodeV3)/, "Prompt model"],
  [/^(OpenRouterDecisions|OpenRouterNoulToBool|GeminiSpatial)/, "Border check"],
  [/^(MiniMaxH3ReferenceToVideo|H3WaitForConditioning)$/, "Encoding (text + references)"],
  [/Sampler/, "Sampling"],
  [/^(VAEDecode|H3ImageDecode)$/, "Decoding"],
  [/^(UNETLoader|CLIPLoader|VAELoader|LoraLoader\w*|LatentUpscaleModelLoader)$/, "Loading models"],
  [/^MiniMaxH3LatentUpscale/, "Latent upscale"],
  [/^VHS_/, "Loading the clip"],
  [/^(CreateVideo|SaveVideo)$/, "Saving the video"],
];

/** The stage a report belongs to. */
export function timingStage(report: Report): string {
  switch (report.stage) {
    case "submitting":
      return "Submitting";
    case "uploading":
      return "Uploading";
    case "queued":
      return "Queued";
    case "downloading":
      return "Downloading";
    case "running": {
      const node = report.node;
      if (!node) return "Running";
      return NODE_STAGES.find(([pattern]) => pattern.test(node))?.[1] ?? node;
    }
    default:
      return report.stage;
  }
}

/** Times consecutive stages; one per render. */
export class RenderTimer {
  private readonly segments: TimingSegment[] = [];
  private current?: { stage: string; since: number };
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Note a report; a new stage closes the last one. */
  mark(report: Report) {
    const stage = timingStage(report);
    if (this.current?.stage === stage) return;
    const at = this.now();
    this.close(at);
    this.current = { stage, since: at };
  }

  /** Close the open stage and return every segment, in order. */
  finish(): TimingSegment[] {
    this.close(this.now());
    this.current = undefined;
    return [...this.segments];
  }

  private close(at: number) {
    if (!this.current) return;
    this.segments.push({ stage: this.current.stage, ms: Math.max(0, at - this.current.since) });
  }
}

/** `1h 02m`, `18m 20s`, `42s`. */
export function formatDuration(ms: number) {
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** Each stage's total, slowest first, with how many separate runs it took. */
export function timingTotals(segments: TimingSegment[]) {
  const totals = new Map<string, { ms: number; runs: number }>();
  for (const { stage, ms } of segments) {
    const total = totals.get(stage) ?? { ms: 0, runs: 0 };
    totals.set(stage, { ms: total.ms + ms, runs: total.runs + 1 });
  }
  return [...totals].map(([stage, total]) => ({ stage, ...total })).sort((a, b) => b.ms - a.ms);
}

/** `Took 18m 20s: Sampling 5m 02s (2×) · Prompt model 3m 10s · …`, stages under a second left out. */
export function formatTimingSummary(segments: TimingSegment[]) {
  const all = segments.reduce((sum, { ms }) => sum + ms, 0);
  const parts = timingTotals(segments)
    .filter(({ ms }) => ms >= 1000)
    .map(({ stage, ms, runs }) => `${stage} ${formatDuration(ms)}${runs > 1 ? ` (${runs}×)` : ""}`);
  return `Took ${formatDuration(all)}${parts.length ? `: ${parts.join(" · ")}` : ""}`;
}

/** Every segment in order, for the server log: `Queued 12s → Prompt model 3m 10s → …`. */
export function formatTimingTimeline(segments: TimingSegment[]) {
  return segments
    .filter(({ ms }) => ms >= 1000)
    .map(({ stage, ms }) => `${stage} ${formatDuration(ms)}`)
    .join(" → ");
}

/** Segments out of an untrusted answer (a stored outcome can outlive a build). */
export function readTiming(value: unknown): TimingSegment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const segments = value.filter(
    (item): item is TimingSegment =>
      Boolean(item) &&
      typeof (item as TimingSegment).stage === "string" &&
      typeof (item as TimingSegment).ms === "number" &&
      Number.isFinite((item as TimingSegment).ms),
  );
  return segments.length > 0 ? segments : undefined;
}
