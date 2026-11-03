/**
 * What model files a loader can see on the active render target.
 *
 * A bare ComfyUI, or one behind comfy-api-proxy, answers
 * `GET /object_info/<loader>` with the widget's enum. A hosted deployment only
 * serves `/api/v2/...`, so that route 404s there and the names are asked for a
 * different way: a throwaway graph is submitted with an impossible file name
 * wired to a real output, and ComfyUI's validation answers with the list it
 * would have accepted.
 *
 * Nothing executes — validation fails before the first node runs — but the
 * probe does leave one failed job in the target's history, which is the price
 * of an honest list rather than a guess.
 */

import { randomUUID } from "node:crypto";

import { redirectMode } from "./account.ts";

export type LoaderList = { ok: true; options: string[] } | { ok: false; status: number };

/** A name no install can have, so validation always refuses it. */
export const PROBE_NAME = "__cinematic_probe__.safetensors";

/** Each list the probe reads back: its loader class and that loader's file field. */
const PROBE_LOADERS = {
  unet: { class_type: "UNETLoader", field: "unet_name" },
  clip: { class_type: "CLIPLoader", field: "clip_name" },
  lora: { class_type: "LoraLoaderModelOnly", field: "lora_name" },
  upscaler: { class_type: "LatentUpscaleModelLoader", field: "model_name" },
} as const;

export type LoaderKind = keyof typeof PROBE_LOADERS;
export type LoaderLists = Partial<Record<LoaderKind, string[]>>;

/**
 * The probe: both loaders wired — through a text encoder, a guider and one
 * sampler step — into a `SaveImage`, so the graph has an output and every node
 * is reachable. Unconnected nodes are never validated, which is why a bare
 * loader node would answer nothing.
 *
 * `extras` also wires a LoRA into the model and H3's latent upscaler in front
 * of the sampler, for Openjutsu's LoRA and upscaler lists. The upscale node is
 * core, but only in a ComfyUI recent enough for H3, so it is asked for only by
 * the gear that needs it.
 */
export function probeGraph(extras = false) {
  const graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: PROBE_NAME, weight_dtype: "default" } },
    "2": { class_type: "EmptyLatentImage", inputs: { width: 64, height: 64, batch_size: 1 } },
    "3": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "4": { class_type: "RandomNoise", inputs: { noise_seed: 0 } },
    "5": { class_type: "BasicScheduler", inputs: { model: ["1", 0], scheduler: "simple", steps: 1, denoise: 1 } },
    "6": { class_type: "BasicGuider", inputs: { model: ["1", 0], conditioning: ["7", 0] } },
    "7": { class_type: "CLIPTextEncode", inputs: { clip: ["8", 0], text: "probe" } },
    "8": { class_type: "CLIPLoader", inputs: { clip_name: PROBE_NAME, type: "minimax", device: "default" } },
    "9": { class_type: "VAELoader", inputs: { vae_name: PROBE_NAME } },
    "10": {
      class_type: "SamplerCustomAdvanced",
      inputs: { noise: ["4", 0], guider: ["6", 0], sampler: ["3", 0], sigmas: ["5", 0], latent_image: ["2", 0] },
    },
    "11": { class_type: "VAEDecode", inputs: { samples: ["10", 0], vae: ["9", 0] } },
    "12": { class_type: "SaveImage", inputs: { images: ["11", 0], filename_prefix: "cinematic/verify-probe" } },
  };
  if (extras) {
    graph["13"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: PROBE_NAME, strength_model: 1 } };
    graph["14"] = { class_type: "LatentUpscaleModelLoader", inputs: { model_name: PROBE_NAME } };
    graph["15"] = {
      class_type: "MiniMaxH3LatentUpscaleWithModel",
      inputs: { model: ["14", 0], samples: ["2", 0], width: 64, height: 64 },
    };
    graph["6"]!.inputs.model = ["13", 0];
    graph["10"]!.inputs.latent_image = ["15", 0];
  }
  return graph;
}

/** `unet_name: 'x' not in ['a', 'b']` → `["a", "b"]`. */
export function parseNotInList(details: string, field: string): string[] | undefined {
  if (!details.startsWith(`${field}:`)) return undefined;
  const start = details.indexOf("[");
  const end = details.lastIndexOf("]");
  if (start < 0 || end <= start) return undefined;
  const options = details
    .slice(start + 1, end)
    .split(",")
    .map((option) => option.trim().replace(/^['"]|['"]$/g, "").trim())
    .filter(Boolean);
  return options.length > 0 ? options : undefined;
}

/**
 * The lists a failed probe reported, read off `error.node_errors`.
 *
 * ComfyUI keys those by node id and each entry carries the class, so the probe
 * does not depend on its own node numbering surviving a change to the graph.
 */
export function listsFromNodeErrors(nodeErrors: unknown): LoaderLists {
  const out: LoaderLists = {};
  if (!nodeErrors || typeof nodeErrors !== "object") return out;

  for (const entry of Object.values(nodeErrors as Record<string, unknown>)) {
    const detail = entry as { class_type?: unknown; errors?: unknown };
    const errors = Array.isArray(detail?.errors) ? detail.errors : [];
    for (const item of errors) {
      const details = (item as { details?: unknown })?.details;
      if (typeof details !== "string") continue;
      for (const [kind, loader] of Object.entries(PROBE_LOADERS) as [LoaderKind, (typeof PROBE_LOADERS)[LoaderKind]][]) {
        if (detail.class_type === loader.class_type && !out[kind]) out[kind] = parseNotInList(details, loader.field);
      }
    }
  }
  return out;
}

function authHeaders(key: string | undefined, json = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (key) headers.authorization = `Bearer ${key}`;
  if (json) headers["content-type"] = "application/json";
  return headers;
}

/**
 * Ask a v2-only target for its loader lists by submitting the probe.
 *
 * Undefined when the target refuses the job outright or never finishes
 * validating it — the caller then reports that the names cannot be listed.
 */
export async function probeLoaderLists(
  base: string,
  key: string | undefined,
  timeoutMs = 25_000,
  extras = false,
): Promise<LoaderLists | undefined> {
  const root = base.replace(/\/+$/, "");

  const submit = await fetch(`${root}/api/v2/jobs`, {
    method: "POST",
    headers: { ...authHeaders(key, true), "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ workflow: probeGraph(extras) }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
    redirect: redirectMode(),
  });
  if (!submit.ok) return undefined;

  const created = (await submit.json().catch(() => undefined)) as { id?: unknown } | undefined;
  const jobId = typeof created?.id === "string" ? created.id : undefined;
  if (!jobId) return undefined;

  const deadline = Date.now() + timeoutMs;
  let delay = 400;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(Math.round(delay * 1.4), 2_000);

    const poll = await fetch(`${root}/api/v2/jobs/${encodeURIComponent(jobId)}`, {
      headers: authHeaders(key),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      redirect: redirectMode(),
    }).catch(() => undefined);
    if (!poll?.ok) continue;

    const job = (await poll.json().catch(() => undefined)) as
      | { status?: unknown; error?: { node_errors?: unknown } }
      | undefined;
    if (typeof job?.status !== "string") continue;
    if (!["succeeded", "failed", "canceled", "expired"].includes(job.status)) continue;
    return listsFromNodeErrors(job.error?.node_errors);
  }

  return undefined;
}

/** `GET /object_info/<loader>` — the widget's enum, on a target that has it. */
async function objectInfo(base: string, key: string | undefined, node: string, field: string): Promise<LoaderList> {
  const response = await fetch(`${base}/object_info/${node}`, {
    headers: authHeaders(key),
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
    redirect: redirectMode(),
  });
  if (!response.ok) return { ok: false, status: response.status };

  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  const info = body?.[node] as
    | { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } }
    | undefined;
  const spec = (info?.input?.required?.[field] ?? info?.input?.optional?.[field]) as unknown[] | undefined;
  const options = Array.isArray(spec?.[0]) ? (spec[0] as string[]) : undefined;

  return options ? { ok: true, options } : { ok: false, status: response.status };
}

/**
 * The UNET and CLIP lists one target offers, whichever surface it speaks, and
 * with `extras` its LoRA and latent upscaler lists too.
 *
 * `/object_info` first; when it is missing — 404 from a bare v2 gateway, 405
 * from a static fallback — the probe supplies the same lists.
 */
export async function loaderLists(
  base: string,
  key?: string,
  extras = false,
): Promise<{ unet: LoaderList; clip: LoaderList; lora?: LoaderList; upscaler?: LoaderList }> {
  const kinds: LoaderKind[] = extras ? ["unet", "clip", "lora", "upscaler"] : ["unet", "clip"];
  const fetched = await Promise.all(
    kinds.map((kind) => objectInfo(base, key, PROBE_LOADERS[kind].class_type, PROBE_LOADERS[kind].field)),
  );
  const lists = Object.fromEntries(kinds.map((kind, index) => [kind, fetched[index]!])) as Record<LoaderKind, LoaderList>;
  const { unet, clip } = lists;

  const missingRoute = (list: LoaderList) => !list.ok && (list.status === 404 || list.status === 405);
  if (!unet.ok && !clip.ok && (missingRoute(unet) || missingRoute(clip))) {
    const probed = await probeLoaderLists(base, key, undefined, extras);
    if (probed) {
      for (const kind of kinds) {
        const options = probed[kind];
        if (options) lists[kind] = { ok: true, options };
      }
    }
  }

  return lists;
}
