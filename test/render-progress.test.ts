import assert from "node:assert/strict";
import test from "node:test";
import { progressFromJob } from "../lib/local-video.ts";
import {
  clearProgress,
  finishProgress,
  isRenderId,
  progressLabel,
  readProgress,
  reportProgress,
  takeOutcome,
} from "../lib/render-progress.ts";

test("a running deployment job reports its sampler step", () => {
  const update = progressFromJob({
    status: "running",
    progress: {
      current_node: "11",
      current_node_class: "SamplerCustomAdvanced",
      message: "SamplerCustomAdvanced 21/25",
      nodes_done: 13,
      nodes_total: 18,
      step: 21,
      steps: 25,
      value: 0.77,
    },
  });
  assert.deepEqual(update, { stage: "running", step: 21, steps: 25, node: "SamplerCustomAdvanced", value: 0.77 });
  assert.equal(progressLabel(update!), "Sampling 21/25");
});

test("a queued job reports its place, and terminal states are left to the runner", () => {
  assert.deepEqual(progressFromJob({ status: "queued", queue_position: 2 }), { stage: "queued", queuePosition: 2 });
  assert.deepEqual(progressFromJob({ status: "queued", queue_position: null }), { stage: "queued" });
  assert.equal(progressFromJob({ status: "succeeded", progress: { value: 1 } }), undefined);
  assert.equal(progressFromJob(undefined), undefined);
  // Between samplers there is a node but no step.
  const decoding = progressFromJob({ status: "running", progress: { current_node_class: "VAEDecode", value: 0.9 } });
  assert.deepEqual(decoding, { stage: "running", node: "VAEDecode", value: 0.9 });
  assert.equal(progressLabel(decoding!), "Decoding…");
});

test("a new stage drops the last one's numbers; the start time is kept", () => {
  const id = "0f8503ca-8858-411d-bf8b-9a8703e6de8a";
  reportProgress(id, { stage: "running", step: 4, steps: 25 });
  const started = readProgress(id)!.startedAt;
  reportProgress(id, { stage: "downloading" });

  const record = readProgress(id)!;
  assert.equal(record.stage, "downloading");
  assert.equal(record.step, undefined);
  assert.equal(record.startedAt, started);

  clearProgress(id);
  assert.equal(readProgress(id), undefined);
  // No id, no record: a request without a tile is not tracked.
  reportProgress(undefined, { stage: "queued" });
});

test("a finished render is kept for one collection; a failure keeps its words", () => {
  const ok = "6ecb454b-85f7-4318-aeb5-184b0f8503ca";
  reportProgress(ok, { stage: "running", step: 25, steps: 25 });
  finishProgress(ok, true, { kind: "video", src: "data:video/mp4;base64,AAAA" });
  assert.equal(readProgress(ok)!.stage, "done");
  assert.deepEqual(takeOutcome(ok), { kind: "video", src: "data:video/mp4;base64,AAAA" });
  // Collected once: the record and the body are both gone.
  assert.equal(takeOutcome(ok), undefined);
  assert.equal(readProgress(ok), undefined);

  const bad = "8858411d-bf8b-4a87-9e6d-e8a0f8503ca1";
  finishProgress(bad, false, { error: "unet_name: 'x' not in list" });
  assert.deepEqual([readProgress(bad)!.stage, readProgress(bad)!.error], ["failed", "unet_name: 'x' not in list"]);
  assert.equal(takeOutcome(bad), undefined);
  finishProgress("c0ffee00-0000-4000-8000-000000000000", false, "not json");
  assert.equal(readProgress("c0ffee00-0000-4000-8000-000000000000")!.error, "The clip could not be rendered.");
});

test("only uuid-shaped render ids are accepted", () => {
  assert.equal(isRenderId("bb55e4d4-fa98-418d-9c12-b9d8d5207226"), true);
  assert.equal(isRenderId("../etc/passwd"), false);
  assert.equal(isRenderId(42), false);
});
