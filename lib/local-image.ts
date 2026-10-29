/**
 * FLUX 3 on the machine the app runs on.
 *
 * Router takes a request body (see the harness route); a local ComfyUI takes an
 * API-format workflow. This module builds that graph from the same settings,
 * submits it, and returns the bytes — so the studio can offer FLUX 3 twice:
 * once per render on Router, once free on local hardware.
 *
 * The graph is the core FLUX 3 Klein text-to-image stack (UNETLoader +
 * CLIPLoader with type `flux3` + VAELoader → CLIPTextEncode →
 * ConditioningZeroOut → EmptyFlux2LatentImage → KSampler → VAEDecode →
 * SaveImage). File names are settings, not constants, because every install
 * names its checkpoints differently.
 *
 * Both HTTP surfaces are supported, exactly as for local H3: a Comfy
 * deployment speaks API v2 and the Comfy SDK drives it, while a bare ComfyUI
 * speaks the classic `/prompt`, `/history` and `/view` routes.
 */

import { Comfy } from "@comfyorg/sdk";
import {
  IMAGE_RATIOS,
  LOCAL_IMAGE_DEFAULTS,
  MAX_IMAGE_BATCH,
  clampImageBatch,
  localImageModelConfig,
  type ImageResolution,
  type LocalImageModelConfig,
} from "./harness.ts";
import {
  classicAssetName,
  classicError,
  classicRunError,
  classicViewUrl,
  detectLocalSurface,
  localEndpoint,
  localFailure,
  splitDataUri,
  type ClassicFileRef,
  type LocalGraph,
  type LocalSurface,
  type LocalUpload,
} from "./local-video.ts";

/** The resolution classes FLUX 3 renders, in pixels along a square's edge. */
import { redirectMode } from "./account.ts";

const TIER_EDGE: Record<ImageResolution, number> = {
  "768sq": 768,
  "1k": 1024,
  "1.5k": 1536,
  "2k": 2048,
  "4k": 4096,
};

/** The same classes as megapixels, for the edit node's resize mode. */
const TIER_MEGAPIXELS: Record<ImageResolution, number> = {
  "768sq": 0.6,
  "1k": 1,
  "1.5k": 2.4,
  "2k": 4.2,
  "4k": 16.8,
};

/** The 1k class, the size a fresh square render starts on. */
export const LOCAL_IMAGE_SIZE = TIER_EDGE["1k"];

/** The node whose image output the runner reads back. */
export const LOCAL_IMAGE_SAVE_NODE = "9";

/**
 * Pixel dimensions for a ratio and size class.
 *
 * A class is a constant pixel area (`edge²`), shaped by the ratio — the same
 * reading as a 4K square, which the provider documents as about 16.8 MP.
 * Both sides sit on the 16-pixel grid the latent loader likes.
 */
export function localImageDimensions(ratio: string, resolution: ImageResolution = "1k") {
  const edge = TIER_EDGE[resolution] ?? TIER_EDGE["1k"];
  const shape = IMAGE_RATIOS.find((option) => option.id === ratio);
  // Auto follows a reference on Router; the local graph has none, so square.
  const w = shape && shape.w > 0 ? shape.w : 1;
  const h = shape && shape.h > 0 ? shape.h : 1;
  const scale = edge / Math.sqrt(w * h);
  const snap = (value: number) => Math.max(64, Math.round(value / 16) * 16);
  return { width: snap(w * scale), height: snap(h * scale) };
}

/** The FLUX 3 Klein install's file names and step count. */
export type LocalImageFiles = {
  unet: string;
  clip: string;
  vae: string;
  steps: number;
};

/**
 * The file names a stock FLUX 3 Klein install has. The diffusion model and the
 * Qwen3-VL text encoder come from the picker's configuration dialog; the VAE
 * can still be overridden per machine with FLUX_VAE in `.env.local`.
 */
export const DEFAULT_LOCAL_IMAGE_FILES: LocalImageFiles = {
  unet: LOCAL_IMAGE_DEFAULTS.unet,
  clip: LOCAL_IMAGE_DEFAULTS.clip,
  vae: "flux2-vae.safetensors",
  steps: LOCAL_IMAGE_DEFAULTS.steps,
};

/** Graph loader values for one configuration, with the VAE from the environment. */
export function localImageFiles(
  config: LocalImageModelConfig,
  env: NodeJS.ProcessEnv = process.env,
): LocalImageFiles {
  return {
    unet: config.unet,
    clip: config.clip,
    vae: env.FLUX_VAE?.trim() || DEFAULT_LOCAL_IMAGE_FILES.vae,
    steps: config.steps,
  };
}

export type LocalImageInput = {
  prompt: string;
  /** Defaults to 1:1. */
  ratio?: string;
  /** Defaults to 1k. */
  resolution?: ImageResolution;
  /** Images in one graph, 1–4. Defaults to 1. */
  batch?: number;
  /** Canvas mode: the image to edit, as a data URI. */
  canvas?: string;
  /** Further reference images, as data URIs, after the canvas. */
  images?: string[];
};

/**
 * The API-format graph for one render.
 *
 * Pure: no I/O, no clock, no randomness — the seed is a parameter — so the
 * shape the runner submits can be asserted in a test.
 */
export function buildLocalImageGraph(
  input: LocalImageInput,
  files: LocalImageFiles = DEFAULT_LOCAL_IMAGE_FILES,
  seed = 42,
): LocalGraph {
  const { width, height } = localImageDimensions(input.ratio ?? "1:1", input.resolution ?? "1k");
  const batch = clampImageBatch(input.batch, MAX_IMAGE_BATCH);

  return {
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: files.unet, weight_dtype: "default" },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: files.clip, type: "flux3", device: "default" },
    },
    "3": {
      class_type: "VAELoader",
      inputs: { vae_name: files.vae },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { text: input.prompt, clip: ["2", 0] },
    },
    "5": {
      class_type: "ConditioningZeroOut",
      inputs: { conditioning: ["4", 0] },
    },
    "6": {
      class_type: "EmptyFlux2LatentImage",
      inputs: { width, height, batch_size: batch },
    },
    "7": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0],
        positive: ["4", 0],
        negative: ["5", 0],
        latent_image: ["6", 0],
        seed,
        steps: files.steps,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1,
      },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["7", 0], vae: ["3", 0] },
    },
    [LOCAL_IMAGE_SAVE_NODE]: {
      class_type: "SaveImage",
      inputs: { images: ["8", 0], filename_prefix: "cinematic/flux3_klein" },
    },
  };
}

export type LocalImagePlan = { graph: LocalGraph; uploads: LocalUpload[] };

/**
 * The FLUX 3 Klein edit graph, from the provider's `image_flux3_klein_image_edit`
 * workflow: `ReferenceMultiLatent` takes the image being edited as
 * `images.image0`, any further references follow as `images.image1…`, and
 * KSampler takes its positive, negative and latent outputs.
 *
 * `images` is a dynamic input on the node, so the extra slots are the same ones
 * the workflow's own node offers — the canvas is simply always image 0.
 *
 * `resolution` is "resize" at the selected size class, so the output keeps the
 * canvas image's aspect ratio rather than a chip's shape.
 */
export function buildLocalImageEditGraph(
  input: LocalImageInput,
  files: LocalImageFiles = DEFAULT_LOCAL_IMAGE_FILES,
  seed = 42,
): LocalImagePlan {
  if (!input.canvas) throw new Error("Canvas mode needs an image to edit.");
  const resolution = input.resolution ?? "1k";

  const graph: LocalGraph = {
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: files.unet, weight_dtype: "default" },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: files.clip, type: "flux3", device: "default" },
    },
    "3": {
      class_type: "VAELoader",
      inputs: { vae_name: files.vae },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { text: input.prompt, clip: ["2", 0] },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: { text: "", clip: ["2", 0] },
    },
    "54": {
      class_type: "LoadImage",
      inputs: { image: "canvas.png" },
    },
  };

  const uploads: LocalUpload[] = [{ nodeId: "54", field: "image", kind: "image", dataUri: input.canvas }];

  const latent: Record<string, unknown> = {
    resolution: "resize",
    "resolution.megapixels": TIER_MEGAPIXELS[resolution] ?? TIER_MEGAPIXELS["1k"],
    positive: ["4", 0],
    negative: ["5", 0],
    vae: ["3", 0],
    "images.image0": ["54", 0],
  };

  (input.images ?? [])
    .filter(Boolean)
    .slice(0, MAX_IMAGE_BATCH - 1)
    .forEach((dataUri, index) => {
      const nodeId = String(100 + index);
      graph[nodeId] = {
        class_type: "LoadImage",
        inputs: { image: `reference_${index + 1}.png` },
      };
      uploads.push({ nodeId, field: "image", kind: "image", dataUri });
      latent[`images.image${index + 1}`] = [nodeId, 0];
    });

  graph["17"] = { class_type: "ReferenceMultiLatent", inputs: latent };
  graph["7"] = {
    class_type: "KSampler",
    inputs: {
      model: ["1", 0],
      positive: ["17", 0],
      negative: ["17", 1],
      latent_image: ["17", 2],
      seed,
      steps: files.steps,
      cfg: 1,
      sampler_name: "euler",
      scheduler: "simple",
      denoise: 1,
    },
  };
  graph["8"] = {
    class_type: "VAEDecode",
    inputs: { samples: ["7", 0], vae: ["3", 0] },
  };
  graph[LOCAL_IMAGE_SAVE_NODE] = {
    class_type: "SaveImage",
    inputs: { images: ["8", 0], filename_prefix: "cinematic/flux3_klein_edit" },
  };

  return { graph, uploads };
}

/** The graph and uploads for one local render. */
export function buildLocalImagePlan(
  input: LocalImageInput,
  files: LocalImageFiles = DEFAULT_LOCAL_IMAGE_FILES,
  seed = 42,
): LocalImagePlan {
  if (input.canvas) return buildLocalImageEditGraph(input, files, seed);
  return { graph: buildLocalImageGraph(input, files, seed), uploads: [] };
}

export type LocalImageOutput = { bytes: Uint8Array; contentType: string };
export type LocalImageResult = { images: LocalImageOutput[]; requestId: string | null };

function readField(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

/** Node has no `timers/promises` import here; one tiny wait is enough. */
function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Every file a save node wrote, in server order.
 *
 * `SaveImage` reports `images` on current ComfyUI, while older or animated
 * save nodes use `gifs` / `videos`; all of them carry the same filename triple.
 * A batch writes several entries in one list.
 */
export function classicImageRefs(outputs: unknown, nodeId = LOCAL_IMAGE_SAVE_NODE): ClassicFileRef[] {
  const node = readField(outputs, nodeId);
  if (!node || typeof node !== "object") return [];

  for (const key of ["images", "gifs", "videos", "video"]) {
    const list = readField(node, key);
    if (!Array.isArray(list) || list.length === 0) continue;

    const refs: ClassicFileRef[] = [];
    for (const item of list) {
      const filename = readField(item, "filename");
      if (typeof filename !== "string" || !filename) continue;
      const subfolder = readField(item, "subfolder");
      const type = readField(item, "type");
      refs.push({
        filename,
        subfolder: typeof subfolder === "string" ? subfolder : "",
        type: typeof type === "string" && type ? type : "output",
      });
    }
    if (refs.length > 0) return refs;
  }
  return [];
}

/**
 * Run the graph on a bare ComfyUI: upload, `/prompt`, poll `/history`, `/view`.
 *
 * A text-to-image graph has no uploads; the edit graph uploads its canvas and
 * references first, the same way local H3 does.
 */
async function runClassicImage(
  endpoint: string,
  apiKey: string | undefined,
  plan: LocalImagePlan,
  timeoutMs: number,
): Promise<LocalImageResult> {
  const base = endpoint.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const graph: LocalGraph = structuredClone(plan.graph);
  for (const upload of plan.uploads) {
    const { bytes, filename, contentType } = splitDataUri(upload.dataUri, `${upload.kind ?? "image"}_${upload.nodeId}`);
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    const form = new FormData();
    form.append("image", new Blob([body], { type: contentType }), filename);
    form.append("type", "input");
    form.append("overwrite", "true");

    const response = await fetch(`${base}/upload/image`, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(120_000),
      redirect: redirectMode(),
    });
    if (!response.ok) {
      throw new Error(`ComfyUI refused the ${upload.kind ?? upload.field} upload (HTTP ${response.status}).`);
    }
    graph[upload.nodeId]!.inputs[upload.field] = classicAssetName(await response.json().catch(() => undefined), filename);
  }

  const submit = await fetch(`${base}/prompt`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: `cinematic-${Date.now()}` }),
    signal: AbortSignal.timeout(60_000),
    redirect: redirectMode(),
  });
  const submitted: unknown = await submit.json().catch(() => undefined);
  if (!submit.ok) {
    throw new Error(classicError(submitted) ?? `ComfyUI rejected the graph (HTTP ${submit.status}).`);
  }

  const promptId = readField(submitted, "prompt_id");
  if (typeof promptId !== "string" || !promptId) {
    throw new Error(classicError(submitted) ?? "ComfyUI accepted the graph but returned no prompt id.");
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/history/${encodeURIComponent(promptId)}`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
      redirect: redirectMode(),
    });
    const history: unknown = await response.json().catch(() => undefined);
    const entry = readField(history, promptId);

    if (entry && typeof entry === "object") {
      const failure = classicRunError(entry);
      if (failure) throw new Error(failure);

      const refs = classicImageRefs(readField(entry, "outputs"));
      if (refs.length > 0) {
        const images = await Promise.all(
          refs.map(async (ref) => {
            const download = await fetch(classicViewUrl(base, ref), {
              headers,
              cache: "no-store",
              signal: AbortSignal.timeout(120_000),
              redirect: redirectMode(),
            });
            if (!download.ok) throw new Error(`Could not download the image (HTTP ${download.status}).`);
            const bytes = new Uint8Array(await download.arrayBuffer());
            if (bytes.byteLength === 0) throw new Error("The local render came back empty.");
            return { bytes, contentType: download.headers.get("content-type") ?? "image/png" };
          }),
        );
        return { images, requestId: promptId };
      }

      // Finished, but the save node reported nothing to fetch.
      if (readField(readField(entry, "status"), "completed") === true) {
        throw new Error("The local graph finished without an image output.");
      }
    }

    await wait(1_200);
  }

  throw new Error(`The local render did not finish within ${Math.round(timeoutMs / 1000)}s.`);
}

/** Build a client for one endpoint, the way the local H3 runner does. */
function clientFor(endpoint: string, apiKey?: string) {
  const previous = process.env.COMFY_BASE_URL;
  process.env.COMFY_BASE_URL = endpoint;
  try {
    return new Comfy({ apiKey, timeoutMs: 60_000 });
  } finally {
    if (previous === undefined) delete process.env.COMFY_BASE_URL;
    else process.env.COMFY_BASE_URL = previous;
  }
}

/**
 * Run one render on the local ComfyUI.
 *
 * Throws with a readable message when the endpoint is missing or the job
 * fails; the route turns that into a 5xx the panel can show.
 */
export async function runLocalImage(
  input: LocalImageInput,
  options: {
    files?: LocalImageFiles;
    seed?: number;
    apiKey?: string;
    /** A Comfy deployment (Settings). Falls back to COMFY_BASE_URL. */
    baseUrl?: string;
    /** Model / clip / steps from the picker's configuration dialog. */
    config?: LocalImageModelConfig;
    timeoutMs?: number;
    /** Skip the probe when the caller already knows the surface. */
    surface?: LocalSurface;
  } = {},
): Promise<LocalImageResult> {
  const endpoint = options.baseUrl?.trim() || localEndpoint();
  if (!endpoint) {
    throw new Error(
      "Workflow renders need a Comfy deployment (Settings) or COMFY_BASE_URL pointing at your ComfyUI.",
    );
  }

  const plan = buildLocalImagePlan(
    input,
    options.files ?? localImageFiles(options.config ?? localImageModelConfig(undefined)),
    options.seed ?? 42,
  );

  // A bare ComfyUI has no /api/v2; ask once, then submit the way it expects.
  const surface = options.surface ?? (await detectLocalSurface(endpoint, options.apiKey));
  if (surface === "classic") {
    return runClassicImage(endpoint, options.apiKey, plan, options.timeoutMs ?? 600_000);
  }

  const client = clientFor(endpoint, options.apiKey);
  const workflow = client.workflows.fromJson(plan.graph);
  for (const upload of plan.uploads) {
    const { bytes, filename, contentType } = splitDataUri(upload.dataUri, `${upload.kind ?? "image"}_${upload.nodeId}`);
    const asset = client.assets.fromBytes(bytes, { filename, contentType });
    workflow.setInput(upload.nodeId, upload.field, asset);
  }

  const job = await client.run(workflow, { timeoutMs: options.timeoutMs ?? 600_000 }).catch((error: unknown) => {
    throw localFailure(error);
  });
  const outputs = job.getOutputs(LOCAL_IMAGE_SAVE_NODE);
  if (outputs.length === 0) throw new Error("The local graph produced no image output.");

  const images = await Promise.all(
    outputs.map(async (output) => {
      const bytes = await output.toBytes();
      if (bytes.byteLength === 0) throw new Error("The local render came back empty.");
      return { bytes, contentType: output.contentType || "image/png" };
    }),
  );

  return { images, requestId: job.id ?? null };
}
