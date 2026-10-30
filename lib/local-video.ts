/**
 * MiniMax H3 on the machine the app runs on.
 *
 * Router takes a request body (see `buildVideoRequest`); a local ComfyUI takes
 * an API-format workflow. This module builds that graph from the same
 * settings, submits it, and returns the bytes — so the studio can offer H3
 * twice: once per render on Router, once free on local hardware.
 *
 * Two surfaces are supported. A Comfy deployment (or comfy-api-proxy) speaks
 * API v2, which the Comfy SDK drives. A bare ComfyUI speaks the classic API,
 * so the same plan is posted to `/prompt` and read back from `/history` and
 * `/view` — pointing the app straight at ComfyUI is the obvious thing to do,
 * and its static-file fallback answers a v2 POST with 405 rather than a
 * useful error.
 *
 * The graph is the core-node H3 stack (UNETLoader + CLIPLoader + two VAEs →
 * MiniMaxH3ReferenceToVideo → sampler → decode → SaveVideo). File names are
 * settings, not constants, because every install names its checkpoints
 * differently.
 *
 * A reference's own sound is the finished mix, so `CreateVideo` is fed from the
 * `LoadAudio` node, or from the audio output of the `GetVideoComponents` node
 * that also supplies the motion reference's frames. Only a free render — or a
 * silent motion reference — decodes H3's audio latents.
 */

import { Comfy } from "@comfyorg/sdk";
import {
  CONTINUATION_FRAMES,
  LOCAL_MODEL_DEFAULTS,
  MAX_DURATION,
  MIN_DURATION,
  localModelConfig,
  type LocalModelConfig,
  type VideoMode,
  type VideoResolution,
} from "./video.ts";

/** H3 renders at 24 fps. */
import { redirectMode } from "./account.ts";
import type { RenderProgress } from "./render-progress.ts";

export const LOCAL_FPS = 24;
/** H3 wants a few frames past the whole second, as its own graphs do. */
const TAIL_FRAMES = 4;

/** The node whose video output the runner reads back. */
export const LOCAL_SAVE_NODE = "15";

/** The H3 install's file names and step count. */
export type LocalVideoFiles = {
  unet: string;
  clip: string;
  videoVae: string;
  audioVae: string;
  steps: number;
  /** Cap on the motion reference's short edge, or 0/undefined for the output's. */
  refVideoEdge?: number;
};

/**
 * The H3 file names and step count a fresh install starts from. The model and
 * clip come from the picker's configuration dialog (the model defaults to the
 * 8-step fasth3 OmniRef build); the VAEs can still be overridden per machine
 * with H3_VAE_* in `.env.local`.
 */
export const DEFAULT_LOCAL_FILES: LocalVideoFiles = {
  unet: LOCAL_MODEL_DEFAULTS.unet,
  clip: LOCAL_MODEL_DEFAULTS.clip,
  videoVae: "minimax_h3_video_vae_fp16.safetensors",
  audioVae: "minimax_h3_audio_vae_fp32.safetensors",
  steps: LOCAL_MODEL_DEFAULTS.steps,
};

/**
 * Sizes for the ratios H3 renders, per output size. Every value sits on the
 * 32-pixel grid the loader wants, and both tables stay near the same pixel
 * area across ratios so a portrait clip is not four times the cost of a
 * landscape one. `adaptive` has no shape of its own and uses 16:9.
 *
 * Only the sizes the local entry offers appear here — Router's `2K` has no
 * table because a local render is not asked for it, and `localDimensions`
 * falls back to 768P rather than guessing a size.
 */
const DIMENSIONS: Partial<Record<VideoResolution, Record<string, readonly [number, number]>>> = {
  "768P": {
    "3:4": [864, 1152],
    "9:16": [768, 1344],
    "4:3": [1152, 864],
    "16:9": [1344, 768],
    "1:1": [1024, 1024],
  },
  "480P": {
    "3:4": [576, 768],
    "9:16": [480, 864],
    "4:3": [768, 576],
    "16:9": [864, 480],
    "1:1": [480, 480],
  },
};

export type LocalVideoInput = {
  prompt: string;
  mode: VideoMode;
  ratio: string;
  resolution: VideoResolution;
  duration: number;
  /** Reference images, as data URIs. */
  images?: string[];
  /** First frame, as a data URI. Free mode only; selects the i2v graph. */
  firstFrame?: string;
  /** Last frame, as a data URI. Free mode only; selects the i2v graph. */
  lastFrame?: string;
  /** Audio bed, as a data URI. */
  audio?: string;
  /** Motion reference, as a data URI. */
  video?: string;
  /** True when this render continues `video`: only its tail goes to H3. */
  continuation?: boolean;
};

type LocalNode = { class_type: string; inputs: Record<string, unknown> };
export type LocalGraph = Record<string, LocalNode>;

/** One upload the runner has to make before submitting the graph. */
export type LocalUpload = {
  nodeId: string;
  /** The graph input the uploaded file name goes into. */
  field: string;
  /** What is being uploaded, for error messages. */
  kind?: "image" | "audio" | "video";
  dataUri: string;
};

export type LocalVideoPlan = {
  graph: LocalGraph;
  uploads: LocalUpload[];
  width: number;
  height: number;
  frames: number;
  /**
   * Where the finished clip's sound comes from: `reference` when the upload's
   * own track is carried through, `generated` when H3's latents are decoded.
   */
  audioSource: "reference" | "generated";
};

/**
 * H3's length grid, taken from the node's own schema: `length` is frames at
 * 24 fps, default 124 (~5 s), step 17, trained range ~124–362. Valid lengths
 * are therefore 5 + 17k — 124, 141, 158 … 362 — not every whole second's
 * frame count, so a request is snapped to the nearest one.
 */
const FRAME_BASE = 5;
const FRAME_STEP = 17;
const MIN_FRAMES = 124;
const MAX_FRAMES = 362;

/** Frame count H3 accepts for a whole-second clip. */
export function localFrames(seconds: number) {
  const whole = Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(seconds)));
  const wanted = whole * LOCAL_FPS + TAIL_FRAMES;
  const steps = Math.round((wanted - FRAME_BASE) / FRAME_STEP);
  const lowest = (MIN_FRAMES - FRAME_BASE) / FRAME_STEP;
  const highest = (MAX_FRAMES - FRAME_BASE) / FRAME_STEP;
  const k = Math.min(highest, Math.max(lowest, steps));
  return FRAME_BASE + k * FRAME_STEP;
}

/** Width and height for a ratio and output size, falling back to 16:9. */
export function localDimensions(ratio: string, resolution: VideoResolution = "768P") {
  const table = DIMENSIONS[resolution] ?? DIMENSIONS["768P"]!;
  const [width, height] = table[ratio] ?? table["16:9"]!;
  return { width, height };
}

/** Graph loader values for one configuration, with VAEs from the environment. */
export function localFiles(config: LocalModelConfig, env: NodeJS.ProcessEnv = process.env): LocalVideoFiles {
  return {
    unet: config.unet,
    clip: config.clip,
    videoVae: env.H3_VAE_VIDEO?.trim() || DEFAULT_LOCAL_FILES.videoVae,
    audioVae: env.H3_VAE_AUDIO?.trim() || DEFAULT_LOCAL_FILES.audioVae,
    steps: config.steps,
    refVideoEdge: config.refVideoEdge,
  };
}

/**
 * The size a motion reference is scaled to: the render's shape, with its short
 * edge at the cap (or the render's own short edge when there is none) — but
 * never past the clip's own short edge, so a small clip is not upscaled into
 * tokens it has no detail for. Video mode locks the render's ratio to the
 * clip's, so the short edges are the whole comparison. Rounded down onto the
 * 16-pixel grid so rounding never lands above either limit.
 */
export function refVideoDimensions(width: number, height: number, cap?: number, sourceEdge?: number) {
  const short = Math.min(width, height);
  const target = Math.min(cap || short, sourceEdge || Infinity);
  if (target === short) return { width, height };
  const scale = target / short;
  const snap = (value: number) => Math.max(32, Math.floor((value * scale) / 16) * 16);
  return { width: snap(width), height: snap(height) };
}

/** The local ComfyUI's base URL, or undefined when the app has none. */
export function localEndpoint(env: NodeJS.ProcessEnv = process.env) {
  return env.COMFY_BASE_URL?.trim() || undefined;
}

/**
 * The API-format graph for one render, plus the uploads it needs.
 *
 * Pure: no I/O, no clock, no randomness — the seed is a parameter — so the
 * shape the runner submits can be asserted in a test.
 */
export function buildLocalVideoGraph(
  input: LocalVideoInput,
  files: LocalVideoFiles = DEFAULT_LOCAL_FILES,
  seed = 42,
): LocalVideoPlan {
  const { width, height } = localDimensions(input.ratio, input.resolution);
  const frames = localFrames(input.duration);
  // A first or last frame is a Free-mode keyframe (the route refuses them in
  // the reference modes), and it turns the render into H3's image-to-video
  // graph — the one ComfyUI's own MiniMax H3 template ships — rather than the
  // reference stack. Keyframes win over reference images, as on Router.
  const firstFrame = input.mode === "free" ? input.firstFrame : undefined;
  const lastFrame = input.mode === "free" ? input.lastFrame : undefined;
  const keyframes = Boolean(firstFrame || lastFrame);
  const images = keyframes ? [] : (input.images ?? []).filter(Boolean).slice(0, 4);
  const audio = input.mode === "audio" ? input.audio : undefined;
  const video = input.mode === "video" ? input.video : undefined;

  const graph: LocalGraph = {
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: files.unet, weight_dtype: "default" },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: files.clip, type: "minimax", device: "default" },
    },
    "3": {
      class_type: "VAELoader",
      inputs: { vae_name: files.videoVae },
    },
    "4": {
      class_type: "VAELoader",
      inputs: { vae_name: files.audioVae },
    },
  };

  const uploads: LocalUpload[] = [];
  const h3Inputs: Record<string, unknown> = {
    clip: ["2", 0],
    vae: ["3", 0],
    prompt: input.prompt,
    width,
    height,
    length: frames,
  };
  if (keyframes) {
    // The i2v node takes the frames raw: it sizes them to width/height
    // itself, so the template's LoadImage feeds straight in.
    if (firstFrame) {
      graph["100"] = { class_type: "LoadImage", inputs: { image: "first_frame.png" } };
      uploads.push({ nodeId: "100", field: "image", kind: "image", dataUri: firstFrame });
      h3Inputs.first_frame = ["100", 0];
    }
    if (lastFrame) {
      graph["101"] = { class_type: "LoadImage", inputs: { image: "last_frame.png" } };
      uploads.push({ nodeId: "101", field: "image", kind: "image", dataUri: lastFrame });
      h3Inputs.last_frame = ["101", 0];
    }
  } else {
    h3Inputs.audio_vae = ["4", 0];
    h3Inputs.ref_image_size = "match";
  }

  images.forEach((dataUri, index) => {
    const nodeId = String(100 + index);
    graph[nodeId] = {
      class_type: "LoadImage",
      inputs: { image: `reference_${index + 1}.png` },
    };
    uploads.push({ nodeId, field: "image", kind: "image", dataUri });
    h3Inputs[`ref_images.ref_image_${index}`] = [nodeId, 0];
  });

  if (audio) {
    const nodeId = "200";
    graph[nodeId] = {
      class_type: "LoadAudio",
      inputs: { audio: "reference_audio.wav" },
    };
    uploads.push({ nodeId, field: "audio", kind: "audio", dataUri: audio });
    h3Inputs["ref_audios.ref_audio_0"] = [nodeId, 0];
  }

  if (video) {
    const nodeId = "300";
    graph[nodeId] = {
      class_type: "LoadVideo",
      inputs: { file: "reference_video.mp4", "video-preview": "" },
    };
    uploads.push({ nodeId, field: "file", kind: "video", dataUri: video });
    // H3 takes the reference as frames, not as a VIDEO: `ref_videos` is typed
    // IMAGE, so the clip is split first. Its sound comes off the same node.
    graph["301"] = { class_type: "GetVideoComponents", inputs: { video: ["300", 0] } };
    let framesOfGuide: [string, number] = ["301", 0];

    // A continuation hides everything but the run-up to the cut: a negative
    // batch index reads the tail without the graph needing to know the clip's
    // length. `allow_negative_index` is what makes -22 mean "the last 22".
    if (input.continuation) {
      graph["302"] = {
        class_type: "ImageFromBatch",
        inputs: {
          image: ["301", 0],
          batch_index: -CONTINUATION_FRAMES,
          length: CONTINUATION_FRAMES,
          allow_negative_index: true,
        },
      };
      framesOfGuide = ["302", 0];
    }

    // Scale the guide to the render's own size by default, the way the
    // reference workflow does with ImageResizeKJv2. The gear's cap can bring
    // it down (or up) to another short edge without touching the output size,
    // and a clip smaller than either is left at its own size.
    const guide = refVideoDimensions(width, height, files.refVideoEdge, videoShortEdge(video));
    graph["303"] = {
      class_type: "ImageScale",
      inputs: { image: framesOfGuide, upscale_method: "lanczos", ...guide, crop: "center" },
    };
    h3Inputs["ref_videos.ref_video_0"] = ["303", 0];
  }

  /**
   * The sound the finished clip carries.
   *
   * A reference is the real thing: in Audio Reference mode the upload is the
   * finished track, and a motion reference already has its own. Decoding H3's
   * audio latents there would swap a real mix for a regenerated bed, so the
   * reference wins — and only a free render, or a silent reference, has nothing
   * to keep. A continuation is the exception on the video side: it renders new
   * content that merely starts where the source stopped, so its sound is
   * freshly decoded rather than the source's track looping under new frames.
   */
  let clipAudio: [string, number] | undefined;
  if (audio) {
    clipAudio = ["200", 0];
  } else if (video && dataUriHasAudio(video) && !input.continuation) {
    // `audio` is the second output of GetVideoComponents, after `images`.
    clipAudio = ["301", 1];
  }

  graph["5"] = {
    class_type: keyframes ? "MiniMaxH3ImageToVideo" : "MiniMaxH3ReferenceToVideo",
    inputs: h3Inputs,
  };
  // The i2v template runs the checkpoint bare — no sigma shift — and samples
  // with res_multistep; the reference stack keeps its own shift and euler.
  const modelSource: [string, number] = keyframes ? ["1", 0] : ["6", 0];
  if (!keyframes) {
    graph["6"] = {
      class_type: "MiniMaxH3SigmaShift",
      inputs: { model: ["1", 0], shift_video: 12, shift_audio: 3 },
    };
  }
  graph["7"] = { class_type: "BasicGuider", inputs: { model: modelSource, conditioning: ["5", 0] } };
  graph["8"] = { class_type: "RandomNoise", inputs: { noise_seed: seed } };
  graph["9"] = {
    class_type: "KSamplerSelect",
    inputs: { sampler_name: keyframes ? "res_multistep" : "euler" },
  };
  graph["10"] = {
    class_type: "BasicScheduler",
    inputs: { model: modelSource, scheduler: "simple", steps: files.steps, denoise: 1 },
  };
  graph["11"] = {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["8", 0],
      guider: ["7", 0],
      sampler: ["9", 0],
      sigmas: ["10", 0],
      latent_image: ["5", 1],
    },
  };
  graph["12"] = { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["3", 0] } };
  if (!clipAudio) {
    graph["13"] = { class_type: "VAEDecodeAudio", inputs: { samples: ["11", 0], vae: ["4", 0] } };
  }
  graph["14"] = {
    class_type: "CreateVideo",
    inputs: { images: ["12", 0], audio: clipAudio ?? ["13", 0], fps: LOCAL_FPS },
  };
  graph[LOCAL_SAVE_NODE] = {
    class_type: "SaveVideo",
    inputs: {
      video: ["14", 0],
      filename_prefix: "cinematic/h3_local",
      format: "mp4",
      codec: "h264",
    },
  };

  return { graph, uploads, width, height, frames, audioSource: clipAudio ? "reference" : "generated" };
}

/**
 * Whether an uploaded container carries a sound track.
 *
 * The graph can only keep a reference's audio when there is some to keep, and
 * handing `CreateVideo` the audio socket of a silent clip fails the run. MP4
 * marks its tracks with a `soun` handler; WebM names the codec (`A_OPUS`,
 * `A_VORBIS`). Both are plain ASCII inside the header, so a scan is enough and
 * no demuxer is needed.
 */
export function hasAudioTrack(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false;
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  return header.includes("soun") || header.includes("A_OPUS") || header.includes("A_VORBIS");
}

/**
 * An MP4's picture size, from its first track header that has one.
 *
 * `tkhd` stores width and height as 16.16 fixed point at the end of the box;
 * the sound track's are zero, which is how the picture track is told apart.
 * A rotated phone clip keeps its coded size here, which is fine for the one
 * thing this is used for: the short edge. WebM has no `tkhd`, so it reads as
 * unknown and the graph scales as it always has.
 */
export function mp4VideoSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 4; at + 4 <= bytes.byteLength; at++) {
    // "tkhd"
    if (bytes[at] !== 0x74 || bytes[at + 1] !== 0x6b || bytes[at + 2] !== 0x68 || bytes[at + 3] !== 0x64) continue;
    const size = view.getUint32(at - 4);
    const end = at - 4 + size;
    if (size < 92 || end > bytes.byteLength) continue;
    const width = view.getUint32(end - 8) / 65536;
    const height = view.getUint32(end - 4) / 65536;
    if (width >= 1 && height >= 1) return { width: Math.round(width), height: Math.round(height) };
  }
  return undefined;
}

/** A reference data URI's bytes, without throwing on something unusable. */
function dataUriBytes(uri: string) {
  const comma = uri.indexOf(",");
  if (comma < 0) return undefined;
  try {
    return new Uint8Array(Buffer.from(uri.slice(comma + 1), "base64"));
  } catch {
    return undefined;
  }
}

function dataUriHasAudio(uri: string) {
  const bytes = dataUriBytes(uri);
  return bytes ? hasAudioTrack(bytes) : false;
}

/** The short edge of a reference clip, when its container says. */
function videoShortEdge(uri: string) {
  const bytes = dataUriBytes(uri);
  const size = bytes && mp4VideoSize(bytes);
  return size ? Math.min(size.width, size.height) : undefined;
}

/**
 * `data:image/png;base64,...` → bytes plus what the upload should call it.
 *
 * The name has to be unique per upload: a classic ComfyUI stores files by name
 * with `overwrite` set, so a canvas and a reference that both arrived as
 * `reference.jpeg` left only the second one on disk and every node then loaded
 * the same picture.
 */
export function splitDataUri(
  uri: string,
  name = "reference",
): { bytes: Uint8Array; filename: string; contentType: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(uri);
  if (!match) throw new Error("A reference is not a base64 data URI.");
  const [, contentType, payload] = match as unknown as [string, string, string];
  const extension = contentType.split("/")[1]?.split("+")[0] ?? "bin";
  const bytes = new Uint8Array(Buffer.from(payload, "base64"));
  if (bytes.byteLength === 0) throw new Error("A reference decoded to zero bytes.");
  return { bytes, filename: `${name}.${extension}`, contentType };
}

export type LocalVideoResult = { bytes: Uint8Array; contentType: string; requestId: string | null };

/** One stage report from a running render; see `lib/render-progress.ts`. */
export type LocalProgressUpdate = Omit<RenderProgress, "startedAt" | "updatedAt">;
export type OnLocalProgress = (update: LocalProgressUpdate) => void;

/**
 * A v2 job record's progress, as a stage report.
 *
 * The deployment fills `progress` with the running node and, inside a
 * sampler, its step; `queue_position` is set while the job waits for a GPU.
 * Anything terminal is left to the runner, so this only ever says queued or
 * running.
 */
export function progressFromJob(record: unknown): LocalProgressUpdate | undefined {
  const status = field(record, "status");
  if (status === "queued" || status === "pending") {
    const position = field(record, "queue_position");
    return { stage: "queued", ...(typeof position === "number" && position > 0 ? { queuePosition: position } : {}) };
  }
  if (status !== "running") return undefined;

  const progress = field(record, "progress");
  const number = (key: string) => {
    const value = field(progress, key);
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  const node = field(progress, "current_node_class");
  const step = number("step");
  const steps = number("steps");
  const value = number("value");
  return {
    stage: "running",
    ...(step !== undefined && steps ? { step, steps } : {}),
    ...(typeof node === "string" && node ? { node } : {}),
    ...(value !== undefined ? { value } : {}),
  };
}

/**
 * Poll a v2 job's record for progress until `signal` aborts.
 *
 * Polling, not the SSE stream: the record is what the deployment is known to
 * fill, and a dropped poll costs one stale label rather than the render.
 */
async function followJob(
  base: string,
  jobId: string,
  apiKey: string | undefined,
  onProgress: OnLocalProgress,
  signal: AbortSignal,
) {
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  while (!signal.aborted) {
    try {
      const response = await fetch(`${base}/api/v2/jobs/${encodeURIComponent(jobId)}`, {
        headers,
        cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        redirect: redirectMode(),
      });
      const update = progressFromJob(await response.json().catch(() => undefined));
      if (update && !signal.aborted) onProgress(update);
    } catch {
      // A missed poll only delays the next label.
    }
    await wait(2_500);
  }
}

/**
 * Which HTTP surface an endpoint exposes.
 *
 * `v2` is what the SDK speaks and what a Comfy deployment hosts. `classic` is
 * a bare ComfyUI: `/prompt`, `/history/<id>`, `/view` and `/upload/image`.
 * Pointing the app at ComfyUI itself is a reasonable thing to do, so both are
 * supported — but the graph has to be submitted differently.
 */
export type LocalSurface = "v2" | "classic";

/**
 * A classic ComfyUI answers `/api/v2/...` with 404; its static-file fallback
 * answers a POST there with 405, which is the `HTTP 405` people see when the
 * endpoint is ComfyUI rather than comfy-api-proxy.
 */
export function surfaceFromStatus(status: number): LocalSurface {
  return status === 404 || status === 405 ? "classic" : "v2";
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

/** A short probe: the v2 surface always has `/api/v2/jobs`. */
export async function detectLocalSurface(
  endpoint: string,
  apiKey?: string,
  timeoutMs = 8_000,
): Promise<LocalSurface> {
  const base = endpoint.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await fetch(`${base}/api/v2/jobs`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      redirect: redirectMode(),
    });
  } catch {
    throw new Error(`Could not reach ${base} to start the render.`);
  }
  return surfaceFromStatus(response.status);
}

/** The name a `LoadImage` / `LoadAudio` node should be given after an upload. */
export function classicAssetName(body: unknown, fallback: string) {
  const name = field(body, "name");
  const subfolder = field(body, "subfolder");
  const file = typeof name === "string" && name ? name : fallback;
  return typeof subfolder === "string" && subfolder ? `${subfolder}/${file}` : file;
}

/** ComfyUI's own words for a rejected submission, if it gave any. */
export function classicError(body: unknown): string | undefined {
  // Validation failures arrive per node, and each entry carries the words that
  // matter — `unet_name: 'x' not in ['a', 'b']`. The envelope's own message is
  // only "Prompt outputs failed validation", so the nodes are read first.
  const nodeErrors = field(body, "node_errors");
  if (nodeErrors && typeof nodeErrors === "object") {
    const details: string[] = [];
    for (const detail of Object.values(nodeErrors)) {
      const errors = field(detail, "errors");
      if (!Array.isArray(errors)) continue;
      for (const item of errors) {
        const text = field(item, "details");
        const message = field(item, "message");
        const line = typeof text === "string" && text ? text : typeof message === "string" ? message : "";
        if (line) details.push(line);
      }
    }
    if (details.length > 0) return details.join("; ");
  }

  const error = field(body, "error");
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    const parts = [field(error, "message"), field(error, "details")].filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    );
    if (parts.length > 0) return parts.join(": ");
  }
  return undefined;
}

/**
 * The words behind an SDK job failure.
 *
 * `JobFailed.message` is only "job <id> ended failed"; the ComfyUI refusal — the
 * one that names a checkpoint the target does not have — rides on
 * `error.error.message` and `error.error.node_errors`. Without this the panel
 * could never tell a missing model from any other crash.
 */
export function localFailure(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const inner = Reflect.get(error, "error") as
    | { message?: unknown; node_errors?: unknown }
    | undefined;
  if (!inner || typeof inner !== "object") return error;

  const details = classicError({ node_errors: inner.node_errors });
  const message = details ?? (typeof inner.message === "string" ? inner.message : undefined);
  if (!message) return error;

  const better = new Error(message);
  const requestId = Reflect.get(error, "requestId");
  if (typeof requestId === "string") Reflect.set(better, "requestId", requestId);
  return better;
}

/** A run that failed inside the graph, read off its history status. */
export function classicRunError(entry: unknown): string | undefined {
  const status = field(entry, "status");
  const messages = field(status, "messages");

  if (Array.isArray(messages)) {
    for (const item of messages) {
      if (!Array.isArray(item)) continue;
      const [type, data] = item as [unknown, unknown];
      if (type !== "execution_error") continue;
      const message = field(data, "exception_message");
      const node = field(data, "node_type");
      const text = typeof message === "string" && message ? message : "The graph failed while running.";
      return typeof node === "string" && node ? `${node}: ${text}` : text;
    }
  }

  return field(status, "status_str") === "error" ? "The local graph failed while running." : undefined;
}

export type ClassicFileRef = { filename: string; subfolder: string; type: string };

/**
 * The file a save node wrote, out of a history entry's `outputs`.
 *
 * Which key carries it depends on the node: `SaveVideo` reports `images` on
 * current ComfyUI, `SaveAnimatedWEBP` / VHS report `gifs`, and older video
 * packs use `videos`. All of them describe the same `{filename, subfolder,
 * type}` triple, so one reader covers them.
 */
export function classicVideoRef(outputs: unknown, nodeId = LOCAL_SAVE_NODE): ClassicFileRef | undefined {
  const node = field(outputs, nodeId);
  if (!node || typeof node !== "object") return undefined;

  for (const key of ["images", "gifs", "videos", "video"]) {
    const list = field(node, key);
    if (!Array.isArray(list) || list.length === 0) continue;
    const first = list[0];
    const filename = field(first, "filename");
    if (typeof filename !== "string" || !filename) continue;
    const subfolder = field(first, "subfolder");
    const type = field(first, "type");
    return {
      filename,
      subfolder: typeof subfolder === "string" ? subfolder : "",
      type: typeof type === "string" && type ? type : "output",
    };
  }
  return undefined;
}

/** `GET /view` address for a file the classic server wrote. */
export function classicViewUrl(endpoint: string, ref: ClassicFileRef) {
  const base = endpoint.replace(/\/+$/, "");
  const query = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type });
  return `${base}/view?${query.toString()}`;
}

/** Node has no `timers/promises` import here; one tiny wait is enough. */
function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the graph on a bare ComfyUI: upload, `/prompt`, poll `/history`, `/view`.
 *
 * The same plan the SDK path uses, submitted over the routes every ComfyUI has
 * had for years.
 */
async function runClassicVideo(
  endpoint: string,
  apiKey: string | undefined,
  plan: LocalVideoPlan,
  timeoutMs: number,
  onProgress?: OnLocalProgress,
): Promise<LocalVideoResult> {
  const base = endpoint.replace(/\/+$/, "");
  if (plan.uploads.length > 0) onProgress?.({ stage: "uploading" });
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const graph: LocalGraph = structuredClone(plan.graph);
  for (const upload of plan.uploads) {
    const { bytes, filename, contentType } = splitDataUri(upload.dataUri, `${upload.kind ?? "file"}_${upload.nodeId}`);
    // A fresh view over a plain ArrayBuffer: Blob will not take the SDK's
    // ArrayBufferLike-typed slice.
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

  const promptId = field(submitted, "prompt_id");
  if (typeof promptId !== "string" || !promptId) {
    throw new Error(classicError(submitted) ?? "ComfyUI accepted the graph but returned no prompt id.");
  }
  // `/history` only knows a prompt once it has finished, so a bare ComfyUI
  // reports no steps: the tile says "Rendering" until the clip is fetched.
  onProgress?.({ stage: "running" });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/history/${encodeURIComponent(promptId)}`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
      redirect: redirectMode(),
    });
    const history: unknown = await response.json().catch(() => undefined);
    const entry = field(history, promptId);

    if (entry && typeof entry === "object") {
      const failure = classicRunError(entry);
      if (failure) throw new Error(failure);

      const ref = classicVideoRef(field(entry, "outputs"));
      if (ref) {
        onProgress?.({ stage: "downloading" });
        const download = await fetch(classicViewUrl(base, ref), {
          headers,
          cache: "no-store",
          signal: AbortSignal.timeout(180_000),
          redirect: redirectMode(),
        });
        if (!download.ok) throw new Error(`Could not download the clip (HTTP ${download.status}).`);
        const bytes = new Uint8Array(await download.arrayBuffer());
        if (bytes.byteLength === 0) throw new Error("The local render came back empty.");
        return {
          bytes,
          contentType: download.headers.get("content-type") ?? "video/mp4",
          requestId: promptId,
        };
      }

      // Finished, but the save node reported nothing to fetch.
      if (field(field(entry, "status"), "completed") === true) {
        throw new Error("The local graph finished without a video output.");
      }
    }

    await wait(1_500);
  }

  throw new Error(`The local render did not finish within ${Math.round(timeoutMs / 1000)}s.`);
}

/**
 * Build a client for one endpoint.
 *
 * The SDK reads `COMFY_BASE_URL` when the client is constructed and keeps it,
 * so a saved deployment is applied for exactly that moment and then put back.
 * Single-user app, and the value is captured — nothing leaks between requests.
 */
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
export async function runLocalVideo(
  input: LocalVideoInput,
  options: {
    files?: LocalVideoFiles;
    seed?: number;
    apiKey?: string;
    /** A Comfy deployment (Settings). Falls back to COMFY_BASE_URL. */
    baseUrl?: string;
    /** Model / clip / steps from the picker's configuration dialog. */
    config?: LocalModelConfig;
    timeoutMs?: number;
    /** Skip the probe when the caller already knows the surface. */
    surface?: LocalSurface;
    /** Stage and step reports while the render runs. */
    onProgress?: OnLocalProgress;
  } = {},
): Promise<LocalVideoResult> {
  const endpoint = options.baseUrl?.trim() || localEndpoint();
  if (!endpoint) {
    throw new Error(
      "Workflow renders need a Comfy deployment (Settings) or COMFY_BASE_URL pointing at your ComfyUI.",
    );
  }

  const plan = buildLocalVideoGraph(
    input,
    options.files ?? localFiles(options.config ?? localModelConfig(undefined)),
    options.seed ?? 42,
  );

  // A bare ComfyUI has no /api/v2; ask once, then submit the way it expects.
  const surface = options.surface ?? (await detectLocalSurface(endpoint, options.apiKey));
  if (surface === "classic") {
    return runClassicVideo(endpoint, options.apiKey, plan, options.timeoutMs ?? 840_000, options.onProgress);
  }

  const client = clientFor(endpoint, options.apiKey);

  const workflow = client.workflows.fromJson(plan.graph);
  for (const upload of plan.uploads) {
    const { bytes, filename, contentType } = splitDataUri(upload.dataUri, `${upload.kind ?? "file"}_${upload.nodeId}`);
    const asset = client.assets.fromBytes(bytes, { filename, contentType });
    workflow.setInput(upload.nodeId, upload.field, asset);
  }

  // Submit and wait apart, rather than `client.run`, so the job's id is known
  // while it runs and its record can be followed for the tile's progress.
  const { onProgress } = options;
  if (plan.uploads.length > 0) onProgress?.({ stage: "uploading" });
  const job = await client.submit(workflow).catch((error: unknown) => {
    throw localFailure(error);
  });
  onProgress?.({ stage: "queued" });

  const following = new AbortController();
  if (onProgress) void followJob(endpoint.replace(/\/+$/, ""), job.id, options.apiKey, onProgress, following.signal);
  try {
    await job.wait(options.timeoutMs ?? 840_000);
    // Terminal now; this throws the job's own failure unless it succeeded.
    await job.result();
  } catch (error) {
    throw localFailure(error);
  } finally {
    following.abort();
  }

  const [output] = job.getOutputs(LOCAL_SAVE_NODE);
  if (!output) throw new Error("The local graph produced no video output.");

  onProgress?.({ stage: "downloading" });
  const bytes = await output.toBytes();
  if (bytes.byteLength === 0) throw new Error("The local render came back empty.");

  return { bytes, contentType: "video/mp4", requestId: job.id ?? null };
}
