import assert from "node:assert/strict";
import test from "node:test";
import { pause, progressFromJob } from "../lib/local-video.ts";
import {
  CANCELLED_MESSAGE,
  cancelRender,
  cancelSignal,
  clearProgress,
  finishProgress,
  isRenderId,
  isSamplerProgress,
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

test("a counter is named after the node keeping it, and dropped when the node changes", () => {
  // VHS counts the source clip's frames while it loads; that is not sampling.
  const loading = { stage: "running" as const, step: 196, steps: 265, node: "VHS_LoadVideoFFmpeg" };
  assert.equal(progressLabel(loading), "Loading the clip 196/265");
  assert.equal(isSamplerProgress(loading), false);
  assert.equal(progressLabel({ stage: "running", node: "OpenRouterStructuredOutputMultiTurn" }), "Thinking…");
  assert.equal(progressLabel({ stage: "running", node: "GeminiNodeV3" }), "Thinking…");
  assert.equal(progressLabel({ stage: "running", node: "OpenRouterDecisions" }), "Checking the frame…");
  assert.equal(isSamplerProgress({ node: "SamplerCustomAdvanced" }), true);
  assert.equal(isSamplerProgress({}), true);

  // The loader's last count must not hang on while the prompt model runs.
  const id = "6d1a77a0-5d6b-4c43-9c7e-6f2b1d1f2a10";
  reportProgress(id, { ...loading, value: 0.2 });
  reportProgress(id, { stage: "running", node: "OpenRouterStructuredOutputMultiTurn" });
  const after = readProgress(id)!;
  assert.equal(after.step, undefined);
  assert.equal(after.steps, undefined);
  assert.equal(after.value, 0.2);
  assert.equal(progressLabel(after), "Thinking…");
  // The same node keeps its numbers between reports that omit them.
  reportProgress(id, { stage: "running", node: "SamplerCustomAdvanced", step: 3, steps: 8 });
  reportProgress(id, { stage: "running", node: "SamplerCustomAdvanced" });
  assert.equal(readProgress(id)!.step, 3);
  clearProgress(id);
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
  assert.equal(readProgress("c0ffee00-0000-4000-8000-000000000000")!.error, "The render failed.");
});

test("only uuid-shaped render ids are accepted", () => {
  assert.equal(isRenderId("bb55e4d4-fa98-418d-9c12-b9d8d5207226"), true);
  assert.equal(isRenderId("../etc/passwd"), false);
  assert.equal(isRenderId(42), false);
});

test("a render can be cancelled by its tile id until it finishes", () => {
  const id = "a11ce000-0000-4000-8000-00000000c0de";
  const signal = cancelSignal(id)!;
  assert.equal(cancelSignal(id), signal, "one signal per render");
  assert.equal(signal.aborted, false);
  assert.equal(cancelRender(id), true);
  assert.equal(signal.aborted, true);
  assert.equal((signal.reason as Error).message, CANCELLED_MESSAGE);
  // Twice is not news, and a finished render is not running to cancel.
  assert.equal(cancelRender(id), false);
  finishProgress(id, false, { error: CANCELLED_MESSAGE, code: "cancelled" });
  assert.equal(readProgress(id)!.error, CANCELLED_MESSAGE);
  assert.equal(cancelRender(id), false);
  assert.equal(cancelSignal(undefined), undefined);
  clearProgress(id);
});

test("a cancellable wait ends early on the cancel", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const waiting = pause(5_000, controller.signal);
  controller.abort();
  await waiting;
  assert.ok(Date.now() - started < 1_000);
  await pause(10);
});
