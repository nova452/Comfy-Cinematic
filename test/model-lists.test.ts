import assert from "node:assert/strict";
import test from "node:test";
import {
  PROBE_NAME,
  listsFromNodeErrors,
  loaderLists,
  parseNotInList,
  probeGraph,
} from "../lib/model-lists.ts";

/** The shape ComfyUI returns for a value that is not in a loader's list. */
const UNET_DETAIL =
  "unet_name: '__probe__.safetensors' not in ['fasth3_omniref_8step_pruned_int8_convrot.safetensors', 'flux3-image-klein-int8-convrot0.safetensors']";

test("a refused value names everything it would have accepted", () => {
  assert.deepEqual(parseNotInList(UNET_DETAIL, "unet_name"), [
    "fasth3_omniref_8step_pruned_int8_convrot.safetensors",
    "flux3-image-klein-int8-convrot0.safetensors",
  ]);

  // Another field's error is not this field's answer.
  assert.equal(parseNotInList(UNET_DETAIL, "clip_name"), undefined);
  assert.equal(parseNotInList("unet_name: something else entirely", "unet_name"), undefined);
  assert.equal(parseNotInList("unet_name: x not in []", "unet_name"), undefined);
});

test("lists are read off the probe's node errors by class", () => {
  const lists = listsFromNodeErrors({
    "1": {
      class_type: "UNETLoader",
      errors: [{ details: UNET_DETAIL, message: "Value not in list", type: "value_not_in_list" }],
    },
    "8": {
      class_type: "CLIPLoader",
      errors: [
        {
          details: "clip_name: 'x' not in ['qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors']",
          message: "Value not in list",
          type: "value_not_in_list",
        },
      ],
    },
    // A third loader is ignored: only the two the dialog asks about matter.
    "9": { class_type: "VAELoader", errors: [{ details: "vae_name: 'x' not in ['a']" }] },
  });

  assert.deepEqual(lists.unet, [
    "fasth3_omniref_8step_pruned_int8_convrot.safetensors",
    "flux3-image-klein-int8-convrot0.safetensors",
  ]);
  assert.deepEqual(lists.clip, ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"]);

  assert.deepEqual(listsFromNodeErrors(undefined), {});
  assert.deepEqual(listsFromNodeErrors({ "1": { class_type: "UNETLoader", errors: "nope" } }), {});
});

test("the probe graph is wired to an output, or nothing would be validated", () => {
  const graph = probeGraph();
  const classes = Object.values(graph).map((node) => node.class_type);
  assert.ok(classes.includes("SaveImage"), "needs an output node");
  assert.equal(graph["1"].inputs.unet_name, PROBE_NAME);
  assert.equal(graph["8"].inputs.clip_name, PROBE_NAME);

  // Both loaders must be reachable from the save node, so walk downstream.
  const consumers = (id: string) =>
    Object.entries(graph)
      .filter(([, node]) =>
        Object.values(node.inputs).some((value) => Array.isArray(value) && value[0] === id),
      )
      .map(([nodeId]) => nodeId);
  const reaches = (from: string, seen = new Set<string>()): boolean => {
    if (from === "12") return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return consumers(from).some((next) => reaches(next, seen));
  };
  assert.ok(reaches("1"), "UNETLoader must feed the output chain");
  assert.ok(reaches("8"), "CLIPLoader must feed the output chain");
});

test("a v2-only target is asked with the probe", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  let polls = 0;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (url.includes("/object_info/")) return new Response("{}", { status: 404 });
    if (url.endsWith("/api/v2/jobs")) return Response.json({ id: "job-1" }, { status: 201 });
    polls += 1;
    if (polls === 1) return Response.json({ status: "running" });
    return Response.json({
      status: "failed",
      error: {
        node_errors: {
          "1": { class_type: "UNETLoader", errors: [{ details: UNET_DETAIL }] },
          "8": {
            class_type: "CLIPLoader",
            errors: [{ details: "clip_name: 'x' not in ['clip-a.safetensors', 'clip-b.safetensors']" }],
          },
        },
      },
    });
  }) as typeof fetch;

  try {
    const lists = await loaderLists("https://dep-test.run.comfy.app", "comfyui-key");
    assert.deepEqual(lists.unet, {
      ok: true,
      options: [
        "fasth3_omniref_8step_pruned_int8_convrot.safetensors",
        "flux3-image-klein-int8-convrot0.safetensors",
      ],
    });
    assert.deepEqual(lists.clip, { ok: true, options: ["clip-a.safetensors", "clip-b.safetensors"] });
    assert.ok(calls.includes("POST /api/v2/jobs"), "the probe submits a job");
  } finally {
    globalThis.fetch = original;
  }
});

test("a target with /object_info is not probed at all", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (url.endsWith("/object_info/UNETLoader")) {
      return Response.json({ UNETLoader: { input: { required: { unet_name: [["a.safetensors"]] } } } });
    }
    if (url.endsWith("/object_info/CLIPLoader")) {
      return Response.json({ CLIPLoader: { input: { required: { clip_name: [["b.safetensors"]] } } } });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    const lists = await loaderLists("http://127.0.0.1:8189");
    assert.deepEqual(lists.unet, { ok: true, options: ["a.safetensors"] });
    assert.deepEqual(lists.clip, { ok: true, options: ["b.safetensors"] });
    assert.ok(!calls.some((call) => call.startsWith("POST")), "no probe on a classic target");
  } finally {
    globalThis.fetch = original;
  }
});
