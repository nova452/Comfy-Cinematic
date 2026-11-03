/**
 * The graph behind the Openjutsu Prime video model: Light is the `H3 ref6`
 * light workflow, Quality the `H3 ref7` quality workflow. Where the plain
 * reference stack hands H3 the user's sentence and the raw stills, this one
 * does the prep work inside the graph, in order:
 *
 * 1. The clip is loaded at 24 fps and capped to the render's length. Light
 *    also checks it for borders: a decision model looks at one frame, and only
 *    when it says the clip needs cropping does Gemini find the real picture.
 * 2. Each character reference is redrawn as a character sheet (portrait plus
 *    front, side and back) by H3 itself, so every subject reaches the video
 *    pass with a full turnaround rather than one pose. All sheets are encoded
 *    before any is sampled (`H3WaitForConditioning`, from the H3 Image pack),
 *    so the text encoder and the model each load once, not once per sheet.
 * 3. A prompt model watches the clip, reads the sheets and writes two H3
 *    prompts. It is Comfy Router's Gemini 3.8 Flash node at high thinking by
 *    default, or the OpenRouter node with Kimi; the Gemini node takes each
 *    sheet as its own image slot, so it needs no batch node. Every regex
 *    output the graph uses is checked: a blank one asks the prompt model once
 *    more (a copy of the call that runs only then), and a second blank stops
 *    the render.
 * 4. The final render is always the same two passes over one latent: the
 *    OmniRef model runs the first sigma steps, then the ref2va model with the
 *    Pika flex LoRA finishes from that latent on the workflow's manual list.
 * 5. Light: #1 is the user's request (#2, the subjects painted red, is not
 *    used); the two passes render it on the clip. Quality: #1 swaps the
 *    targeted subjects for chroma-key dummies, rendered on the clip (no
 *    sheets) in one 6-step pass on the ref2va + Pika chain; #2 swaps the
 *    dummies for the characters, and the two passes render it on that dummy
 *    render, with the sheets.
 * 6. Both, only when the gear turns it on (off is the default): an upscale
 *    pass. H3's latent upscaler doubles the latent, and the finishing chain
 *    with the regenerate refiner LoRA appended resamples it on the same
 *    conditioning. It samples four times the tokens of the main pass, so long
 *    clips can run out of memory there. The finished pass is decoded and saved
 *    before it starts, so a failed upscale still leaves the generated clip at
 *    the render's own size to fall back to; with it off, that decode is the
 *    clip that is saved.
 *
 * The gear's mode picks between the two; nothing else about the passes is a
 * setting.
 *
 * Pure, like `buildLocalVideoGraph`: the seed and the key are parameters.
 */

import type { LocalGraph, LocalUpload, LocalVideoFiles, LocalVideoInput, LocalVideoPlan } from "./local-video.ts";
import {
  REF5_PICTURES_LINE,
  REF5_REQUEST_TEMPLATE,
  REF5_SHEET_PROMPT,
  REF5_SYSTEM_PROMPT,
  REF6_LIGHT_TASK,
  REF7_QUALITY_TASK,
} from "./ref5-prompts.ts";
import {
  BLANK_PROMPT_MESSAGE,
  MAX_REF5_IMAGES,
  OPENJUTSU_DEFAULTS,
  OPENJUTSU_REFINER_LORAS,
  REF2VA_LORA_DEFAULT,
  REF2VA_UNET_DEFAULT,
  OPENJUTSU_REF_VIDEO_LIMIT,
  REF5_UPSCALER_DEFAULT,
  type OpenjutsuMode,
} from "./video.ts";

/**
 * The second-pass model and LoRA, and the upscale pass's latent upscaler;
 * the gear's Extras, then `H3_REF2VA_UNET` / `H3_REF2VA_LORA` /
 * `H3_LATENT_UPSCALER`, override them.
 */
export const REF5_DEFAULTS = {
  ref2vaUnet: REF2VA_UNET_DEFAULT,
  ref2vaLora: REF2VA_LORA_DEFAULT,
  latentUpscaler: REF5_UPSCALER_DEFAULT,
  /** The OpenRouter prompt model, used when the gear picks that API. */
  promptModel: "moonshotai/kimi-k3.1-pro",
  decisionModel: "perplexity/pplx-decider-v1.2",
  spatialModel: "gemini-3.5-flash-lite",
} as const;

/**
 * The Comfy Router prompt call: the node's model label and its thinking.
 * `HIGH` is the option the gear's Gemini entry names.
 */
export const REF5_GEMINI_MODEL = "Gemini 3.8 Flash";
export const REF5_GEMINI_THINKING = "HIGH";

/** Tokens the Gemini answer may use, thinking included; the node's own default. */
const GEMINI_MAX_TOKENS = 32_768;

/**
 * Every first pass takes the first `FIRST_PASS_SPLIT` sigmas of a
 * `FIRST_PASS_STEPS`-step simple schedule (6 steps); the second pass then
 * finishes on the workflow's own list (5 steps).
 */
const FIRST_PASS_STEPS = 24;
const FIRST_PASS_SPLIT = 6;
const SECOND_PASS_SIGMAS = "0.972973, 0.923077, 0.8, 0.571429, 0.333333, 0.0";

/** Quality's dummy pass: this whole list (6 steps) from pure noise, on ref2va + Pika. */
const DUMMY_SIGMAS = "1.0, 0.972973, 0.923077, 0.8, 0.571429, 0.333333, 0.0";

/** Steps each character sheet is sampled for, as the workflow sets it. */
const SHEET_STEPS = 8;

/**
 * The upscale pass: the latent's scale, and its schedule. It starts below 1.0
 * so the upscaled pass-2 latent survives the noise: H3 mixes noise in as
 * `sigma * noise + (1 - sigma) * latent`, so a 1.0 start would discard it.
 */
const UPSCALE_FACTOR = 2;
const UPSCALE_SIGMAS = "0.909375, 0.857143, 0.666667, 0";

/** Anything but whitespace: what a regex output needs to count as a prompt. */
const NOT_BLANK = "\\S";

/**
 * The guard that stops a render whose retried prompt is still blank. Math
 * Expression evaluates `a or "..."`: true passes, false yields the string and
 * the node fails with a message quoting it, which the app turns into a popup.
 */
const BLANK_GUARD = `a or "${BLANK_PROMPT_MESSAGE}, so the render was stopped."`;

/**
 * The files the ref6 graph loads beyond the gear's model and clip, as the
 * graph will name them. Verify checks the same names.
 */
export function ref6Files(
  files: Pick<LocalVideoFiles, "ref2vaUnet" | "ref2vaLora" | "latentUpscaler" | "refinerLora">,
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    ref2vaUnet: files.ref2vaUnet || env.H3_REF2VA_UNET?.trim() || REF5_DEFAULTS.ref2vaUnet,
    ref2vaLora: files.ref2vaLora || env.H3_REF2VA_LORA?.trim() || REF5_DEFAULTS.ref2vaLora,
    latentUpscaler: files.latentUpscaler || env.H3_LATENT_UPSCALER?.trim() || REF5_DEFAULTS.latentUpscaler,
    refinerLora: files.refinerLora || OPENJUTSU_REFINER_LORAS[0],
  };
}

/** The frame the border check looks at: past any fade-in, inside a 5 s clip. */
const CHECK_FRAME = 36;

/** Megapixels the motion reference is scaled to, per output size. */
const MEGAPIXELS: Record<string, number> = { "480P": 0.4, "768P": 1 };

/** Each prompt's six sections: the first, and the second found after it. */
const FIRST_PROMPT = "(subject_definitions:.*?non_diegetic_music:[^\\n]*\\n[^\\n]*)";
const SECOND_PROMPT =
  "subject_definitions:.*?non_diegetic_music:[^\\n]*\\n[^\\n]*.*?(subject_definitions:.*?non_diegetic_music:[^\\n]*\\n[^\\n]*)";

/** A JSON list of `{box_2d, label}` boxes inside Gemini's reply. */
const BOX_LIST =
  '\\[\\s*(\\{\\s*"box_2d"\\s*:\\s*\\[\\d+,\\s*\\d+,\\s*\\d+,\\s*\\d+\\]\\s*,\\s*"label"\\s*:\\s*"[^"]+"\\s*\\}\\s*,?\\s*)*\\](?!\\])';

const CROP_TARGETS =
  '["video_frame_canvas"]\n\n*This is part of a large video editing pipeline, your task is to find whether the video frame a user has provided is a screen recording/contains borders/etc and pinpoint the exact video location for cropping';

const CROP_QUESTION =
  "You are inside a large video editing pipeline that pre-processes videos.\nDoes the provided video frame need cropping?";

const CROP_QUESTIONS = JSON.stringify(
  { matches: { type: "noul", instructions: "The content matches the description in the text." } },
  null,
  2,
);

/** First sheet's node ids; each sheet takes ten (load, encode, guide, sample, decode). */
const SHEET_BASE = 410;

/**
 * The request when the user leaves the prompt off: the prompt model plans the
 * whole edit from the clip and the sheets.
 */
export const REF5_AUTO_REQUEST =
  "[The user chose auto mode: you decide where to put the provided characters, which subjects in the video they replace, and everything else about the edit.]";

/** The node whose text output is the prompt H3 rendered, read back after the render. */
export const REF5_PROMPT_NODE = "605";

/**
 * Frames to load for a clip of `seconds`: the workflow's own expression, which
 * rounds up onto H3's 5 + 17k grid so the loaded count is already valid.
 */
export function ref5Frames(seconds: number) {
  const frames = Math.max(5, Math.round(seconds * 24));
  return frames + ((((5 - (frames % 17)) % 17) + 17) % 17);
}

/** `{{name}}` slots, filled in one pass so a value never fills another slot. */
export function fillTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{\{(\w+)\}\}/g, (slot, name: string) => values[name] ?? slot);
}

/** What the prompt model is asked, for a request, a number of stills and a mode. */
export function ref5Request(request: string, images: number, mode: OpenjutsuMode = OPENJUTSU_DEFAULTS.mode) {
  return fillTemplate(REF5_REQUEST_TEMPLATE, {
    request,
    pictures: images > 0 ? fillTemplate(REF5_PICTURES_LINE, { images_n: String(images) }) : "",
    task: mode === "light" ? REF6_LIGHT_TASK : REF7_QUALITY_TASK,
  });
}

/** `ImageScaleToTotalPixels`'s size for a clip, as ComfyUI computes it. */
export function ref5Dimensions(source: { width: number; height: number } | undefined, resolution: string) {
  const megapixels = MEGAPIXELS[resolution] ?? MEGAPIXELS["768P"]!;
  const { width, height } = source ?? { width: 16, height: 9 };
  const scale = Math.sqrt((megapixels * 1024 * 1024) / (width * height));
  const snap = (value: number) => Math.max(32, Math.round((value * scale) / 32) * 32);
  return { width: snap(width), height: snap(height), megapixels };
}

export type Ref5Options = {
  /**
   * OpenRouter key for the decision, spatial and OpenRouter prompt models.
   * Empty is legal: Quality on the Gemini prompt API uses no OpenRouter node.
   */
  openRouterKey?: string;
  /** The clip's picture size, when its container says. */
  sourceSize?: { width: number; height: number };
  /** Whether the clip carries a sound track to keep. */
  sourceAudio: boolean;
  env?: NodeJS.ProcessEnv;
};

export function buildRef5Graph(
  input: LocalVideoInput,
  files: LocalVideoFiles,
  seed: number,
  options: Ref5Options,
): LocalVideoPlan {
  const env = options.env ?? process.env;
  const key = options.openRouterKey ?? "";
  const mode = files.openjutsuMode ?? OPENJUTSU_DEFAULTS.mode;
  const quality = mode === "quality";
  const upscale = files.upscale === true;
  const promptApi = files.promptApi ?? OPENJUTSU_DEFAULTS.promptApi;
  const names = ref6Files(files, env);
  // Every still is a character: the clip already sets the scene, so this
  // mode takes no background reference.
  const characters = (input.images ?? []).filter(Boolean).slice(0, MAX_REF5_IMAGES);
  const frames = ref5Frames(input.duration);
  const { width, height, megapixels } = ref5Dimensions(options.sourceSize, input.resolution);

  const uploads: LocalUpload[] = [];
  const graph: LocalGraph = {
    "2": { class_type: "CLIPLoader", inputs: { clip_name: files.clip, type: "minimax", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: files.videoVae } },
    "4": { class_type: "VAELoader", inputs: { vae_name: files.audioVae } },
    // The sampling chain: the gear's OmniRef model, shifted. Pass 1 and the
    // character sheets run on it.
    "1": { class_type: "UNETLoader", inputs: { unet_name: files.unet, weight_dtype: "default" } },
    "6": { class_type: "MiniMaxH3SigmaShift", inputs: { model: ["1", 0], shift_video: 10, shift_audio: 3 } },
    "16": { class_type: "ModelAttentionBackend", inputs: { model: ["6", 0], attention: "comfy kitchen attention" } },
    "17": {
      class_type: "BlockSparseAttention",
      inputs: {
        model: ["16", 0],
        selection: "vsa",
        "selection.keep_percent": 10,
        start_percent: 0.2,
        end_percent: 1,
        dense_blocks: "",
        min_tokens: 12288,
        extra_tokens: 256,
        sink_conditioning: "exact_kv_and_rows",
        verbose: false,
      },
    },
  };
  // Pass 2's finishing model: the ref2va checkpoint with the Pika LoRA.
  graph["18"] = { class_type: "UNETLoader", inputs: { unet_name: names.ref2vaUnet, weight_dtype: "default" } };
  graph["19"] = {
    class_type: "LoraLoaderModelOnly",
    inputs: { model: ["18", 0], lora_name: names.ref2vaLora, strength_model: 1 },
  };
  const chain: [string, number] = ["17", 0];

  // 1. The clip, its length, and (Light) the border check. The trim window is
  // cut here, from the clip as uploaded: skip to its start, load its length.
  graph["300"] = {
    class_type: "VHS_LoadVideoFFmpeg",
    inputs: {
      video: "reference_video.mp4",
      force_rate: 24,
      custom_width: 0,
      custom_height: 0,
      frame_load_cap: frames,
      start_time: Math.max(0, Math.round((input.start ?? 0) * 1000) / 1000),
      // Stock VHS has no "H3" preset; what it set is done here instead:
      // force_rate is 24, the cap is already on H3's frame grid, and the
      // guide is resized onto 32 px further down.
      format: "None",
    },
  };
  uploads.push({ nodeId: "300", field: "video", kind: "video", dataUri: input.video ?? "" });
  // Loaded Frames Count: how many frames VHS actually loaded, which is what
  // the conditionings render. It matches the cap unless the clip ends early.
  graph["301"] = { class_type: "VHS_VideoInfo", inputs: { video_info: ["300", 3] } };
  // The border check is an OpenRouter chain: the decision model first, then
  // Gemini for the box. With the Comfy API picked there is no key, so it is
  // skipped and the clip is used as uploaded; the upload's crop window is the
  // only crop then.
  const crop = !quality && promptApi === "openrouter";
  if (crop) borderCheck();
  graph["320"] = {
    class_type: "ImageScaleToTotalPixels",
    inputs: { image: crop ? ["318", 0] : ["300", 0], upscale_method: "bicubic", megapixels, resolution_steps: 32 },
  };
  graph["321"] = { class_type: "GetImageSize", inputs: { image: ["320", 0] } };
  const guide: [string, number] = ["320", 0];

  // A silent clip has no track for VHS to hand over, so H3 hears silence.
  let sound: [string, number] = ["300", 2];
  if (!options.sourceAudio) {
    graph["322"] = {
      class_type: "EmptyAudio",
      inputs: { duration: Math.max(1, Math.ceil(frames / 24)), sample_rate: 44100, channels: 2 },
    };
    sound = ["322", 0];
  }

  /** The border check: crop only when the decision model and Gemini's boxes agree. */
  function borderCheck() {
    // The workflow's "Frame Select" is not a core node; ImageFromBatch is.
    graph["310"] = { class_type: "ImageFromBatch", inputs: { image: ["300", 0], batch_index: CHECK_FRAME, length: 1 } };
    graph["311"] = {
      class_type: "OpenRouterDecisions",
      inputs: {
        api_key: key,
        model: REF5_DEFAULTS.decisionModel,
        state_text: CROP_QUESTION,
        questions: CROP_QUESTIONS,
        image: ["310", 0],
      },
    };
    graph["312"] = { class_type: "OpenRouterNoulToBool", inputs: { answers: ["311", 1], question: "", threshold: 0.5 } };
    graph["314"] = {
      class_type: "GeminiSpatialNode",
      inputs: {
        target: CROP_TARGETS,
        image: ["310", 0],
        model: REF5_DEFAULTS.spatialModel,
        task_type: "2D bounding boxes",
        temperature: 0.6,
        reasoning_effort: "minimal",
        service_tier: "default",
        api_key: key,
      },
    };
    graph["315"] = {
      class_type: "RegexExtract",
      inputs: {
        string: ["314", 1],
        regex_pattern: BOX_LIST,
        mode: "First Match",
        case_insensitive: true,
        multiline: true,
        dotall: false,
        group_index: 1,
      },
    };
    graph["316"] = {
      class_type: "GeminiSpatialBBoxNode",
      inputs: { json_output: ["315", 0], image: ["300", 0], label: "video_frame_canvas", drop_size: 20 },
    };
    // Cropped only when the decision model asked for it and Gemini found a box.
    graph["317"] = {
      class_type: "ComfySwitchNode",
      inputs: { switch: ["312", 0], on_false: ["300", 0], on_true: ["316", 4] },
    };
    graph["318"] = {
      class_type: "ComfySwitchNode",
      inputs: { switch: ["316", 3], on_false: ["300", 0], on_true: ["317", 0] },
    };
  }

  // 2. A character sheet per character reference.
  const sheets: [string, number][] = [];
  if (characters.length > 0) {
    graph["400"] = {
      class_type: "ResolutionSelector",
      inputs: { aspect_ratio: "16:9 (Widescreen)", megapixels: 1, multiple: 32 },
    };
    graph["401"] = { class_type: "H3ImageLatent", inputs: { width: ["400", 0], height: ["400", 1], batch_size: 1 } };
    graph["402"] = { class_type: "RandomNoise", inputs: { noise_seed: seed + 1 } };
    graph["403"] = { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } };
    graph["404"] = {
      class_type: "BasicScheduler",
      inputs: { model: chain, scheduler: "simple", steps: SHEET_STEPS, denoise: 1 },
    };
  }
  characters.forEach((dataUri, index) => {
    const base = SHEET_BASE + index * 10;
    const id = (offset: number) => String(base + offset);
    graph[id(0)] = { class_type: "LoadImage", inputs: { image: `reference_${index + 1}.png` } };
    uploads.push({ nodeId: id(0), field: "image", kind: "image", dataUri });
    graph[id(1)] = {
      class_type: "MiniMaxH3ReferenceToVideo",
      inputs: {
        prompt: REF5_SHEET_PROMPT,
        width: ["400", 0],
        height: ["400", 1],
        length: 5,
        ref_image_size: "match",
        clip: ["2", 0],
        vae: ["3", 0],
        audio_vae: ["4", 0],
        "ref_images.ref_image_0": [id(0), 0],
      },
    };
    graph[id(2)] = { class_type: "BasicGuider", inputs: { model: chain, conditioning: [id(1), 0] } };
    graph[id(3)] = {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["402", 0],
        guider: [id(2), 0],
        sampler: ["403", 0],
        sigmas: ["404", 0],
        latent_image: ["405", 0],
      },
    };
    graph[id(4)] = { class_type: "H3ImageDecode", inputs: { samples: [id(3), 0], vae: ["3", 0] } };
    sheets.push([id(4), 0]);
  });
  // Every sheet sampler waits on every sheet's conditioning, so the text
  // encoder runs all of them on one load and the model then samples them all
  // on one load, rather than the two swapping in and out once per sheet.
  if (characters.length > 0) {
    graph["405"] = {
      class_type: "H3WaitForConditioning",
      inputs: {
        samples: ["401", 0],
        ...Object.fromEntries(
          characters.map((_, index) => [`conditioning_${index}`, [String(SHEET_BASE + index * 10 + 1), 0]]),
        ),
      },
    };
  }

  // 3. The prompt model writes both prompts from the clip and the stills.
  const request = ref5Request(input.auto ? REF5_AUTO_REQUEST : input.prompt, sheets.length, mode);
  const openRouterPrompt = (seed: number): Record<string, unknown> => ({
    system_prompt: REF5_SYSTEM_PROMPT,
    user_prompt: request,
    api_key: key,
    model: REF5_DEFAULTS.promptModel,
    temperature: 1,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
    seed,
    reasoning_effort: "xhigh",
    service_tier: "default",
    json_schema: "",
    response_format: "json_schema",
    ...(sheets.length > 0 ? { image: ["600", 0] } : {}),
    video: ["601", 0],
  });
  // Comfy Router's Gemini node has one image slot per sheet, so the sheets go
  // in one by one and no BatchImagesNode is needed.
  const geminiPrompt = (seed: number): Record<string, unknown> => ({
    model: REF5_GEMINI_MODEL,
    "model.prompt": request,
    "model.system_prompt": REF5_SYSTEM_PROMPT,
    "model.thinking_level": REF5_GEMINI_THINKING,
    "model.max_output_tokens": GEMINI_MAX_TOKENS,
    "model.seed": seed,
    "model.video_processing": "static",
    "model.video.video_1": ["601", 0],
    ...Object.fromEntries(sheets.map((source, index) => [`model.images.image_${index + 1}`, source])),
  });
  if (promptApi === "openrouter" && sheets.length > 0) {
    graph["600"] = {
      class_type: "BatchImagesNode",
      inputs: Object.fromEntries(sheets.map((source, index) => [`images.image${index}`, source])),
    };
  }
  graph["601"] = {
    class_type: "CreateVideo",
    inputs: { images: guide, audio: sound, fps: 24, bit_depth: 8, color_space: "sRGB", codec: "none" },
  };
  // Each call has a retry twin (+10) on another seed. Nothing reads it unless
  // a check below finds a blank prompt, so it never runs otherwise.
  const call = (id: string, seed: number) => {
    const class_type = promptApi === "openrouter" ? "OpenRouterStructuredOutputMultiTurn" : "GeminiNodeV3";
    graph[id] = {
      class_type,
      inputs: promptApi === "openrouter" ? openRouterPrompt(seed) : geminiPrompt(seed),
    };
    graph[String(Number(id) + 10)] = {
      class_type,
      inputs: promptApi === "openrouter" ? openRouterPrompt(seed + 1) : geminiPrompt(seed + 1),
    };
  };
  call("602", 0);

  const extract = (source: string, pattern: string) => ({
    class_type: "RegexExtract",
    inputs: {
      string: [source, 0],
      regex_pattern: pattern,
      mode: "First Group",
      case_insensitive: true,
      multiline: false,
      dotall: true,
      group_index: 1,
    },
  });
  const notBlank = (source: string) => ({
    class_type: "RegexMatch",
    inputs: { string: [source, 0], regex_pattern: NOT_BLANK, case_insensitive: true, multiline: false, dotall: false },
  });
  /**
   * A regex output, checked: if it is blank, the same regex on the retry
   * call's answer; if that is blank too, the guard fails the render.
   * Nodes `base` to `base + 5`.
   */
  const checked = (id: string, source: string, pattern: string, base: number): [string, number] => {
    const at = (offset: number) => String(base + offset);
    graph[id] = extract(source, pattern);
    graph[at(0)] = notBlank(id);
    graph[at(1)] = extract(String(Number(source) + 10), pattern);
    graph[at(2)] = notBlank(at(1));
    graph[at(3)] = { class_type: "ComfyMathExpression", inputs: { expression: BLANK_GUARD, "values.a": [at(2), 0] } };
    graph[at(4)] = {
      class_type: "ComfySwitchNode",
      inputs: { switch: [at(3), 2], on_true: [at(1), 0], on_false: [at(1), 0] },
    };
    graph[at(5)] = { class_type: "ComfySwitchNode", inputs: { switch: [at(0), 0], on_true: [id, 0], on_false: [at(4), 0] } };
    return [at(5), 0];
  };

  // The gear's video reference cap, as MiniMax H3 Local's: the reference video
  // H3 encodes is brought down to that short edge, while the render keeps the
  // guide's size. Worked out in the graph, since the border check may crop:
  // `min` keeps a reference already under the cap at its own size. 544p is a
  // hard limit, Match output included: past it a render runs over 32 minutes.
  const cap = Math.min(files.refVideoEdge || OPENJUTSU_REF_VIDEO_LIMIT, OPENJUTSU_REF_VIDEO_LIMIT);
  const cappedIds = new Map<string, [string, number]>();
  let nextCapId = 324;
  const capped = (video: [string, number]): [string, number] => {
    const known = cappedIds.get(video[0]);
    if (known) return known;
    const edge = String(nextCapId++);
    const resized = String(nextCapId++);
    graph[edge] = {
      class_type: "ComfyMathExpression",
      inputs: { expression: `min(a, b, ${cap})`, "values.a": ["321", 0], "values.b": ["321", 1] },
    };
    graph[resized] = {
      class_type: "ResizeImageMaskNode",
      inputs: {
        input: video,
        resize_type: "scale shorter dimension",
        "resize_type.shorter_size": [edge, 1],
        scale_method: "bicubic",
      },
    };
    const out: [string, number] = [resized, 0];
    cappedIds.set(video[0], out);
    return out;
  };

  /**
   * One H3 conditioning. `size` is the render's width and height (the
   * guide's by default); `refs` are the reference images (the sheets by
   * default); `capVideo` false takes a reference that is already within the
   * cap as it is.
   */
  type Link = [string, number];
  const h3 = (
    prompt: Link,
    video: Link,
    {
      refs = sheets,
      size = [["321", 0], ["321", 1]],
      capVideo = true,
    }: { refs?: Link[]; size?: [Link, Link]; capVideo?: boolean } = {},
  ) => {
    const inputs: Record<string, unknown> = {
      prompt,
      width: size[0],
      height: size[1],
      // What VHS loaded (Video Info's loaded_frame_count), as the workflow
      // does. H3 snaps an off-grid count onto its 5 + 17k grid itself.
      length: ["301", 6],
      ref_image_size: "match",
      clip: ["2", 0],
      vae: ["3", 0],
      audio_vae: ["4", 0],
      "ref_videos.ref_video_0": capVideo ? capped(video) : video,
      "ref_video_audios.ref_video_audio_0": sound,
    };
    refs.forEach((source, index) => {
      inputs[`ref_images.ref_image_${index}`] = source;
    });
    return { class_type: "MiniMaxH3ReferenceToVideo", inputs };
  };

  graph["9"] = { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } };
  graph["8"] = { class_type: "RandomNoise", inputs: { noise_seed: seed } };
  // Shared by every two-pass render: pass 1's schedule, pass 2's list, and
  // pass 2's noise (none: it continues pass 1's latent).
  graph["10"] = {
    class_type: "BasicScheduler",
    inputs: { model: chain, scheduler: "simple", steps: FIRST_PASS_STEPS, denoise: 1 },
  };
  graph["20"] = { class_type: "SplitSigmas", inputs: { sigmas: ["10", 0], step: FIRST_PASS_SPLIT } };
  graph["23"] = { class_type: "DisableNoise", inputs: {} };
  graph["24"] = { class_type: "ManualSigmas", inputs: { sigmas: SECOND_PASS_SIGMAS } };

  /**
   * The two passes over one latent on one conditioning: OmniRef for the first
   * sigma steps, then ref2va + Pika to the end. Returns pass 2's latent.
   * `ids` are pass 1's guider and sampler, then pass 2's.
   */
  const twoPass = (
    conditioning: [string, number],
    latent: [string, number],
    noise: [string, number],
    ids: [string, string, string, string],
  ): [string, number] => {
    const [guide1, pass1, guide2, pass2] = ids;
    graph[guide1] = { class_type: "BasicGuider", inputs: { model: chain, conditioning } };
    graph[pass1] = {
      class_type: "SamplerCustomAdvanced",
      inputs: { noise, guider: [guide1, 0], sampler: ["9", 0], sigmas: ["20", 0], latent_image: latent },
    };
    graph[guide2] = { class_type: "BasicGuider", inputs: { model: ["19", 0], conditioning } };
    graph[pass2] = {
      class_type: "SamplerCustomAdvanced",
      inputs: { noise: ["23", 0], guider: [guide2, 0], sampler: ["9", 0], sigmas: ["24", 0], latent_image: [pass1, 0] },
    };
    return [pass2, 0];
  };

  let finished: [string, number];
  if (quality) {
    // 5. Quality: the dummies, rendered on the clip with the sheets shrunk
    // to 0.01 MP, then the characters, rendered on that render with them.
    const dummies = checked("603", "602", FIRST_PROMPT, 700);
    const characters = checked("604", "602", SECOND_PROMPT, 710);

    // The dummy pass keeps ref7's single pass: the full list in one go with
    // `lcm`, on its own shifted ref2va + Pika chain, decoded from the
    // denoised estimate.
    graph["26"] = { class_type: "MiniMaxH3SigmaShift", inputs: { model: ["19", 0], shift_video: 10, shift_audio: 3 } };
    graph["27"] = { class_type: "ModelAttentionBackend", inputs: { model: ["26", 0], attention: "comfy kitchen attention" } };
    graph["28"] = { class_type: "BlockSparseAttention", inputs: { ...graph["17"]!.inputs, model: ["27", 0] } };
    graph["29"] = { class_type: "KSamplerSelect", inputs: { sampler_name: "lcm" } };
    graph["35"] = { class_type: "ManualSigmas", inputs: { sigmas: DUMMY_SIGMAS } };

    // The dummy pass renders at the reference cap's size, not just encodes
    // its reference there: the capped clip sets its size, snapped down onto
    // H3's 32 px grid as the guide is.
    graph["323"] = { class_type: "GetImageSize", inputs: { image: capped(guide) } };
    const snap = (index: number) => ({
      class_type: "ComfyMathExpression",
      inputs: { expression: "max(32, floor(a / 32) * 32)", "values.a": ["323", index] },
    });
    graph["328"] = snap(0);
    graph["329"] = snap(1);
    // Each sheet, shrunk to 0.01 MP, next to its decode (sheet base + 5).
    const hints = sheets.map(([sheet]): Link => {
      const id = String(Number(sheet) + 1);
      graph[id] = {
        class_type: "ImageScaleToTotalPixels",
        inputs: { image: [sheet, 0], upscale_method: "bicubic", megapixels: 0.01, resolution_steps: 1 },
      };
      return [id, 0];
    });
    graph["30"] = h3(dummies, guide, { refs: hints, size: [["328", 1], ["329", 1]] });
    graph["31"] = { class_type: "BasicGuider", inputs: { model: ["28", 0], conditioning: ["30", 0] } };
    graph["32"] = { class_type: "RandomNoise", inputs: { noise_seed: seed + 2 } };
    graph["33"] = {
      class_type: "SamplerCustomAdvanced",
      inputs: { noise: ["32", 0], guider: ["31", 0], sampler: ["29", 0], sigmas: ["35", 0], latent_image: ["30", 1] },
    };
    graph["34"] = { class_type: "VAEDecode", inputs: { samples: ["33", 1], vae: ["3", 0] } };

    graph[REF5_PROMPT_NODE] = { class_type: "PreviewAny", inputs: { source: characters } };
    // The dummy render is already within the cap, so it goes in as it is.
    // The character pass renders at the guide's size, on its own latent.
    graph["21"] = h3(characters, ["34", 0], { capVideo: false });
    finished = twoPass(["21", 0], ["21", 1], ["8", 0], ["7", "11", "22", "25"]);
  } else {
    // 5. Light: the user's request on the clip.
    const prompt = checked("603", "602", FIRST_PROMPT, 700);
    graph[REF5_PROMPT_NODE] = { class_type: "PreviewAny", inputs: { source: prompt } };
    graph["21"] = h3(prompt, guide);
    finished = twoPass(["21", 0], ["21", 1], ["8", 0], ["7", "11", "22", "25"]);
  }
  // The upscale pass's refiner stacks on pass 2's chain.
  const refinerBase: [string, number] = ["19", 0];

  // Pass 2's output, decoded once whether the upscale runs or not — with the
  // upscale off this is the clip that is saved.
  const plain: [string, number] = finished;
  graph["13"] = { class_type: "VAEDecode", inputs: { samples: plain, vae: ["3", 0] } };
  // What the main save writes: the pre-upscale decode, or the upscale's.
  let saved: [string, number] = ["13", 0];

  if (upscale) {
    // The pre-upscale clip is saved before the upscale pass can fail, so a
    // pass that runs out of memory still leaves the generated video behind.
    graph["36"] = {
      class_type: "CreateVideo",
      inputs: { images: ["13", 0], audio: sound, fps: 24, bit_depth: 8, color_space: "sRGB", codec: "none" },
    };
    graph["37"] = {
      class_type: "SaveVideo",
      inputs: {
        video: ["36", 0],
        filename_prefix: quality ? "cinematic/h3_ref7_raw" : "cinematic/h3_ref6_raw",
        format: "mp4",
        codec: "h264",
      },
    };

    // 6. The upscale pass: the latent is doubled by H3's latent upscaler, then
    // resampled on the same conditioning by the finishing chain with the
    // regenerate refiner LoRA appended.
    const doubled = (index: number) => ({
      class_type: "ComfyMathExpression",
      inputs: { expression: `a * ${UPSCALE_FACTOR}`, "values.a": ["321", index] },
    });
    graph["40"] = { class_type: "LatentUpscaleModelLoader", inputs: { model_name: names.latentUpscaler } };
    graph["41"] = doubled(0);
    graph["42"] = doubled(1);
    graph["43"] = {
      class_type: "MiniMaxH3LatentUpscaleWithModel",
      inputs: { model: ["40", 0], samples: finished, width: ["41", 1], height: ["42", 1] },
    };
    graph["44"] = {
      class_type: "LoraLoaderModelOnly",
      inputs: { model: refinerBase, lora_name: names.refinerLora, strength_model: 1 },
    };
    graph["45"] = { class_type: "BasicGuider", inputs: { model: ["44", 0], conditioning: ["21", 0] } };
    graph["46"] = { class_type: "RandomNoise", inputs: { noise_seed: seed + 3 } };
    graph["47"] = { class_type: "ManualSigmas", inputs: { sigmas: UPSCALE_SIGMAS } };
    graph["48"] = {
      class_type: "SamplerCustomAdvanced",
      inputs: { noise: ["46", 0], guider: ["45", 0], sampler: ["9", 0], sigmas: ["47", 0], latent_image: ["43", 0] },
    };
    graph["12"] = { class_type: "VAEDecode", inputs: { samples: ["48", 1], vae: ["3", 0] } };
    saved = ["12", 0];
  }
  graph["14"] = {
    class_type: "CreateVideo",
    inputs: { images: saved, audio: sound, fps: 24, bit_depth: 8, color_space: "sRGB", codec: "none" },
  };
  graph["15"] = {
    class_type: "SaveVideo",
    inputs: { video: ["14", 0], filename_prefix: quality ? "cinematic/h3_ref7" : "cinematic/h3_ref6", format: "mp4", codec: "h264" },
  };

  return {
    graph,
    uploads,
    // The size the clip comes back at: the upscale pass doubles it.
    width: upscale ? width * UPSCALE_FACTOR : width,
    height: upscale ? height * UPSCALE_FACTOR : height,
    frames,
    ...(upscale ? { fallbackNode: "37" } : {}),
    audioSource: options.sourceAudio ? "reference" : "silent",
    promptNode: REF5_PROMPT_NODE,
  };
}
