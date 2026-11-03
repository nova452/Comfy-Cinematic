import assert from "node:assert/strict";
import test from "node:test";
import { progressFromJob } from "../lib/local-video.ts";
import {
  RenderTimer,
  formatDuration,
  formatTimingSummary,
  formatTimingTimeline,
  readTiming,
  timingStage,
  timingTotals,
} from "../lib/render-timing.ts";

/** A clock the test moves by hand. */
function clock() {
  let now = 0;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test("each node class lands in the stage a person would name", () => {
  const running = (node?: string) => timingStage({ stage: "running", node });
  assert.equal(running("OpenRouterStructuredOutputMultiTurn"), "Prompt model");
  assert.equal(running("GeminiNodeV3"), "Prompt model");
  assert.equal(running("MiniMaxH3ReferenceToVideo"), "Encoding (text + references)");
  assert.equal(running("SamplerCustomAdvanced"), "Sampling");
  assert.equal(running("VAEDecode"), "Decoding");
  assert.equal(running("H3ImageDecode"), "Decoding");
  assert.equal(running("UNETLoader"), "Loading models");
  assert.equal(running("LoraLoaderModelOnly"), "Loading models");
  assert.equal(running("VHS_LoadVideoFFmpeg"), "Loading the clip");
  assert.equal(running("MiniMaxH3LatentUpscaleWithModel"), "Latent upscale");
  // Anything else keeps its class name, and a nameless report is just running.
  assert.equal(running("RegexExtract"), "RegexExtract");
  assert.equal(running(), "Running");
  assert.equal(timingStage({ stage: "queued" }), "Queued");
});

test("a stage closes when the next one starts, and repeats stay separate runs", () => {
  const time = clock();
  const timer = new RenderTimer(time.now);
  timer.mark({ stage: "submitting" });
  time.advance(2_000);
  timer.mark({ stage: "queued" });
  time.advance(30_000);
  timer.mark({ stage: "running", node: "OpenRouterStructuredOutputMultiTurn" });
  time.advance(190_000);
  timer.mark({ stage: "running", node: "SamplerCustomAdvanced" });
  time.advance(60_000);
  // A step report from the same sampler does not split it.
  timer.mark({ stage: "running", node: "SamplerCustomAdvanced" });
  time.advance(40_000);
  timer.mark({ stage: "running", node: "MiniMaxH3ReferenceToVideo" });
  time.advance(120_000);
  timer.mark({ stage: "running", node: "SamplerCustomAdvanced" });
  time.advance(100_000);
  timer.mark({ stage: "downloading" });
  time.advance(3_000);

  const segments = timer.finish();
  assert.deepEqual(segments, [
    { stage: "Submitting", ms: 2_000 },
    { stage: "Queued", ms: 30_000 },
    { stage: "Prompt model", ms: 190_000 },
    { stage: "Sampling", ms: 100_000 },
    { stage: "Encoding (text + references)", ms: 120_000 },
    { stage: "Sampling", ms: 100_000 },
    { stage: "Downloading", ms: 3_000 },
  ]);

  // Totals: slowest first, with the number of runs.
  assert.deepEqual(timingTotals(segments)[0], { stage: "Sampling", ms: 200_000, runs: 2 });
  assert.equal(
    formatTimingSummary(segments),
    "Took 9m 05s: Sampling 3m 20s (2×) · Prompt model 3m 10s · Encoding (text + references) 2m 00s · Queued 30s · Downloading 3s · Submitting 2s",
  );
  assert.match(formatTimingTimeline(segments), /^Submitting 2s → Queued 30s → Prompt model 3m 10s → Sampling 1m 40s → /);
});

test("the deployment's job record feeds the timer the running node's class", () => {
  const update = progressFromJob({
    status: "running",
    progress: { current_node_class: "MiniMaxH3ReferenceToVideo", step: 0, steps: 0 },
  })!;
  assert.equal(timingStage(update), "Encoding (text + references)");
});

test("durations read at a glance", () => {
  assert.equal(formatDuration(400), "0s");
  assert.equal(formatDuration(42_000), "42s");
  assert.equal(formatDuration(1_100_000), "18m 20s");
  assert.equal(formatDuration(3_720_000), "1h 02m");
});

test("stored timing is read defensively", () => {
  assert.equal(readTiming(undefined), undefined);
  assert.equal(readTiming("x"), undefined);
  assert.equal(readTiming([{ stage: 1, ms: 2 }]), undefined);
  assert.deepEqual(readTiming([{ stage: "Sampling", ms: 5 }, { nope: true }]), [{ stage: "Sampling", ms: 5 }]);
});
