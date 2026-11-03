import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LOCAL_FILES,
  buildLocalVideoGraph,
  classicError,
  classicRunError,
  classicText,
  localFailure,
  localFiles,
  type LocalGraph,
} from "../lib/local-video.ts";
import { REF5_AUTO_REQUEST, REF5_PROMPT_NODE, fillTemplate, ref5Dimensions, ref5Frames, ref5Request } from "../lib/ref5.ts";
import {
  REF5_SHEET_PROMPT,
  REF5_SYSTEM_PROMPT,
  REF6_LIGHT_TASK,
  REF7_QUALITY_TASK,
} from "../lib/ref5-prompts.ts";
import {
  OPENJUTSU_MODEL_ID,
  VIDEO_MODELS,
  findVideoModel,
  OPENJUTSU_REFINER_LORAS,
  isBlankPromptError,
  isRef5Render,
  localModelConfig,
  maxCharacterImages,
} from "../lib/video.ts";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const MP4 = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28y";
const MP4_AUDIO = `data:video/mp4;base64,${Buffer.from("ftypisommoovtrakmdiahdlrsounmp4a").toString("base64")}`;
const KEY = "sk-or-v1-test";
const FILES = { ...DEFAULT_LOCAL_FILES, openRouterKey: KEY };
/** The OpenRouter prompt API, the choice that existed before Gemini. */
const KIMI = { ...FILES, promptApi: "openrouter" as const };
/** Light is the default; Quality is picked explicitly where its passes matter. */
const LIGHT = { ...FILES, openjutsuMode: "light" as const };
const QUALITY = { ...FILES, openjutsuMode: "quality" as const };
const QUALITY_KIMI = { ...KIMI, openjutsuMode: "quality" as const };
const OPENJUTSU = findVideoModel(OPENJUTSU_MODEL_ID)!;
const H3_LOCAL = findVideoModel("local/minimax-h3")!;

const input = {
  prompt: "Replace the guy in the middle with the character in <image1>.",
  mode: "video" as const,
  openjutsu: true,
  ratio: "16:9",
  resolution: "480P" as const,
  duration: 5,
  video: MP4_AUDIO,
};

function ofType(graph: LocalGraph, type: string) {
  return Object.entries(graph).filter(([, node]) => node.class_type === type);
}

test("Openjutsu Prime builds the ref6/ref7 graph; H3 Local and a continuation do not", () => {
  const plan = buildLocalVideoGraph(input, FILES);
  assert.equal(plan.graph["300"]?.class_type, "VHS_LoadVideoFFmpeg");
  assert.equal(plan.promptNode, REF5_PROMPT_NODE);

  const continued = buildLocalVideoGraph({ ...input, continuation: true }, FILES);
  assert.equal(continued.graph["300"]?.class_type, "LoadVideo");
  assert.equal(continued.promptNode, undefined);

  // H3 Local's own Video Reference keeps the plain stack, key or no key.
  const h3 = buildLocalVideoGraph({ ...input, openjutsu: false }, DEFAULT_LOCAL_FILES);
  assert.equal(h3.graph["300"]?.class_type, "LoadVideo");

  assert.deepEqual(OPENJUTSU.modes, ["video"]);
  assert.equal(OPENJUTSU.provider, "local");
  assert.equal(isRef5Render(OPENJUTSU, "video"), true);
  assert.equal(isRef5Render(OPENJUTSU, "video", true), false);
  assert.equal(isRef5Render(H3_LOCAL, "video"), false);
  assert.ok(VIDEO_MODELS.every((model) => model.id === OPENJUTSU_MODEL_ID || !isRef5Render(model, "video")));
});

test("only the OpenRouter API needs a key", () => {
  // Comfy's Gemini node uses the target's own auth, and Light's border check
  // is skipped without a key, so neither mode needs one.
  assert.doesNotThrow(() => buildLocalVideoGraph(input, DEFAULT_LOCAL_FILES));
  assert.doesNotThrow(() => buildLocalVideoGraph(input, { ...DEFAULT_LOCAL_FILES, openjutsuMode: "light" }));
  // The OR API's Kimi call (and Light's border check) does need one.
  assert.throws(() => buildLocalVideoGraph(input, { ...DEFAULT_LOCAL_FILES, promptApi: "openrouter" }), /OpenRouter key/);
});

test("the key comes from the gear first, then the environment, never on a public host", () => {
  const env = (vars: Record<string, string>): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...vars });
  const saved = localModelConfig({ openRouterKey: " sk-or-saved " });
  assert.equal(saved.openRouterKey, "sk-or-saved");
  assert.equal(localModelConfig({ openRouterKey: "has space" }).openRouterKey, undefined);
  assert.equal(localFiles(saved, env({ OPENROUTER_API_KEY: "sk-or-env" })).openRouterKey, "sk-or-saved");
  assert.equal(localFiles(localModelConfig({}), env({ OPENROUTER_API_KEY: "sk-or-env" })).openRouterKey, "sk-or-env");
  assert.equal(
    localFiles(localModelConfig({}), env({ OPENROUTER_API_KEY: "sk-or-env", PUBLIC_HOSTING: "1" })).openRouterKey,
    undefined,
  );
});

test("every OpenRouter node carries the key", () => {
  // The Comfy API runs no OpenRouter node at all, in either mode: the border
  // check is off without a key.
  for (const files of [QUALITY, LIGHT]) {
    const graph = buildLocalVideoGraph(input, files).graph;
    for (const type of ["OpenRouterDecisions", "GeminiSpatialNode", "OpenRouterStructuredOutputMultiTurn"]) {
      assert.equal(ofType(graph, type).length, 0, type);
    }
  }

  // The OR API adds Kimi's call and retry and Light's two border nodes, all
  // of them keyed.
  const or = buildLocalVideoGraph(input, { ...LIGHT, promptApi: "openrouter" }).graph;
  for (const type of ["OpenRouterDecisions", "GeminiSpatialNode", "OpenRouterStructuredOutputMultiTurn"]) {
    const nodes = ofType(or, type);
    assert.equal(nodes.length, type === "OpenRouterStructuredOutputMultiTurn" ? 2 : 1, type);
    for (const [, node] of nodes) assert.equal(node.inputs.api_key, KEY, type);
  }
});

test("the clip is capped to the render's length on H3's frame grid", () => {
  assert.equal(ref5Frames(5), 124);
  assert.equal(ref5Frames(6), 158);
  assert.equal(ref5Frames(15), 362);
  for (let seconds = 5; seconds <= 15; seconds += 1) {
    const frames = ref5Frames(seconds);
    assert.equal((frames - 5) % 17, 0);
    assert.ok(frames >= seconds * 24);
  }
  const { graph, frames } = buildLocalVideoGraph({ ...input, duration: 7 }, QUALITY);
  assert.equal(graph["300"]!.inputs.frame_load_cap, frames);
  // H3's length is what VHS loaded, read off Video Info's loaded_frame_count.
  assert.deepEqual(graph["301"]!.inputs, { video_info: ["300", 3] });
  assert.equal(graph["301"]!.class_type, "VHS_VideoInfo");
  assert.deepEqual(graph["30"]!.inputs.length, ["301", 6]);
  assert.deepEqual(graph["21"]!.inputs.length, ["301", 6]);
  // Light's conditioning reads it too.
  assert.deepEqual(buildLocalVideoGraph({ ...input, duration: 7 }, LIGHT).graph["21"]!.inputs.length, ["301", 6]);
  // Stock VHS: no "H3" preset.
  assert.equal(graph["300"]!.inputs.format, "None");
  assert.equal(graph["300"]!.inputs.force_rate, 24);
});

test("the trim window is cut in the loader: skip to its start, load its length", () => {
  const plain = buildLocalVideoGraph(input, FILES).graph["300"]!.inputs;
  assert.equal(plain.start_time, 0);

  const trimmed = buildLocalVideoGraph({ ...input, start: 12.3456, duration: 6 }, FILES);
  assert.equal(trimmed.graph["300"]!.inputs.start_time, 12.346);
  assert.equal(trimmed.graph["300"]!.inputs.frame_load_cap, ref5Frames(6));
  assert.equal(trimmed.frames, ref5Frames(6));
  // The whole clip is uploaded as it is; nothing is re-encoded in the browser.
  assert.equal(trimmed.uploads[0]!.dataUri, input.video);
});

test("Light's border check crops only with the OR API on, and both models agree", () => {
  // Comfy has no key, so Light uses the clip as uploaded.
  const comfy = buildLocalVideoGraph(input, LIGHT).graph;
  for (const id of ["310", "311", "312", "314", "315", "316", "317", "318"]) assert.equal(comfy[id], undefined, id);
  assert.deepEqual(comfy["320"]!.inputs.image, ["300", 0]);

  // OR turns the check on; it crops only when the decision and the boxes agree.
  const { graph } = buildLocalVideoGraph(input, { ...LIGHT, promptApi: "openrouter" });
  assert.deepEqual(graph["317"]!.inputs, { switch: ["312", 0], on_false: ["300", 0], on_true: ["316", 4] });
  assert.deepEqual(graph["318"]!.inputs, { switch: ["316", 3], on_false: ["300", 0], on_true: ["317", 0] });
  assert.deepEqual(graph["320"]!.inputs.image, ["318", 0]);

  // Quality (ref7) takes the clip as it is, either way.
  const quality = buildLocalVideoGraph(input, QUALITY).graph;
  for (const id of ["310", "311", "312", "314", "315", "316", "317", "318"]) assert.equal(quality[id], undefined, id);
  assert.deepEqual(quality["320"]!.inputs.image, ["300", 0]);
});

test("each character becomes a sheet, and there is no background slot", () => {
  const plan = buildLocalVideoGraph({ ...input, images: [PNG, PNG, PNG] }, QUALITY_KIMI);
  const sheets = ofType(plan.graph, "H3ImageDecode");
  assert.equal(sheets.length, 3);
  assert.ok(ofType(plan.graph, "MiniMaxH3ReferenceToVideo").some(([, node]) => node.inputs.prompt === REF5_SHEET_PROMPT));

  const refs = Object.entries(plan.graph["21"]!.inputs).filter(([name]) => name.startsWith("ref_images."));
  assert.deepEqual(refs, [
    ["ref_images.ref_image_0", ["414", 0]],
    ["ref_images.ref_image_1", ["424", 0]],
    ["ref_images.ref_image_2", ["434", 0]],
  ]);
  // The main pass and the prompt model see the sheets; Quality's dummy pass
  // sees them shrunk to 0.01 MP.
  const hints = Object.entries(plan.graph["30"]!.inputs).filter(([name]) => name.startsWith("ref_images."));
  assert.deepEqual(hints, [
    ["ref_images.ref_image_0", ["415", 0]],
    ["ref_images.ref_image_1", ["425", 0]],
    ["ref_images.ref_image_2", ["435", 0]],
  ]);
  assert.deepEqual(plan.graph["415"]!, {
    class_type: "ImageScaleToTotalPixels",
    inputs: { image: ["414", 0], upscale_method: "bicubic", megapixels: 0.01, resolution_steps: 1 },
  });
  assert.deepEqual(plan.graph["600"]!.inputs, {
    "images.image0": ["414", 0],
    "images.image1": ["424", 0],
    "images.image2": ["434", 0],
  });
  assert.equal(ofType(plan.graph, "LoadImage").length, 3);
  assert.deepEqual(
    plan.uploads.map((upload) => [upload.nodeId, upload.field]),
    [["300", "video"], ["410", "image"], ["420", "image"], ["430", "image"]],
  );
});

test("every sheet's conditioning is encoded before any sheet is sampled", () => {
  const { graph } = buildLocalVideoGraph({ ...input, images: [PNG, PNG, PNG] }, FILES);
  // Each sampler's latent goes through one gate that holds all three encodes.
  assert.deepEqual(graph["405"]!.inputs, {
    samples: ["401", 0],
    conditioning_0: ["411", 0],
    conditioning_1: ["421", 0],
    conditioning_2: ["431", 0],
  });
  for (const id of ["413", "423", "433"]) assert.deepEqual(graph[id]!.inputs.latent_image, ["405", 0]);

  // No characters, no sheet gate.
  assert.equal(buildLocalVideoGraph(input, FILES).graph["405"], undefined);
});

test("up to eight stills are taken", () => {
  const plan = buildLocalVideoGraph({ ...input, images: Array(10).fill(PNG) }, FILES);
  assert.equal(ofType(plan.graph, "H3ImageDecode").length, 8);
  assert.ok("ref_images.ref_image_7" in plan.graph["21"]!.inputs);
  assert.ok(!("ref_images.ref_image_8" in plan.graph["21"]!.inputs));

  assert.equal(maxCharacterImages(OPENJUTSU, "video", false), 8);
  assert.equal(maxCharacterImages(OPENJUTSU, "video", true), 3);
  assert.equal(maxCharacterImages(H3_LOCAL, "video", false), 3);
});

test("the prompt model is asked with the user's words and the real image count", () => {
  const { graph } = buildLocalVideoGraph({ ...input, images: [PNG, PNG] }, KIMI);
  const node = graph["602"]!;
  assert.equal(node.inputs.system_prompt, REF5_SYSTEM_PROMPT);
  assert.equal(node.inputs.user_prompt, ref5Request(input.prompt, 2));
  assert.match(String(node.inputs.user_prompt), /^user's request:\nReplace the guy/);
  assert.match(String(node.inputs.user_prompt), /- <Picture N>: 2 image\(s\)\./);
  assert.deepEqual(node.inputs.video, ["601", 0]);

  // No stills: no picture line and no image input.
  const bare = buildLocalVideoGraph(input, KIMI).graph["602"]!;
  assert.doesNotMatch(String(bare.inputs.user_prompt), /Picture N/);
  assert.equal(bare.inputs.image, undefined);

  // Prompt off: the prompt model is told to plan the edit, and the box is ignored.
  const auto = buildLocalVideoGraph({ ...input, prompt: "left in the box", auto: true, images: [PNG] }, KIMI).graph[
    "602"
  ]!;
  assert.equal(auto.inputs.user_prompt, ref5Request(REF5_AUTO_REQUEST, 1));
  assert.doesNotMatch(String(auto.inputs.user_prompt), /left in the box/);
  assert.match(String(auto.inputs.user_prompt), /^user's request:\n\[The user chose auto mode/);

  // A slot in the user's own words is left alone.
  assert.match(ref5Request("draw {{images_n}} cats", 3), /draw \{\{images_n\}\} cats/);
  assert.equal(fillTemplate("{{a}}-{{b}}", { a: "{{b}}" }), "{{b}}-{{b}}");
});

test("Gemini is the default prompt API, with one image slot per sheet", () => {
  const { graph } = buildLocalVideoGraph({ ...input, images: [PNG, PNG] }, FILES);
  const node = graph["602"]!;
  assert.equal(node.class_type, "GeminiNodeV3");
  assert.equal(graph["612"]!.class_type, "GeminiNodeV3");
  // Comfy Router's label, high thinking, and the clip as a video part.
  assert.equal(node.inputs.model, "Gemini 3.8 Flash");
  assert.equal(node.inputs["model.thinking_level"], "HIGH");
  assert.equal(node.inputs["model.prompt"], ref5Request(input.prompt, 2));
  assert.equal(node.inputs["model.system_prompt"], REF5_SYSTEM_PROMPT);
  assert.deepEqual(node.inputs["model.video.video_1"], ["601", 0]);
  // Each sheet has its own slot; there is no batch node.
  assert.deepEqual(node.inputs["model.images.image_1"], ["414", 0]);
  assert.deepEqual(node.inputs["model.images.image_2"], ["424", 0]);
  assert.equal(node.inputs["model.images.image_3"], undefined);
  assert.equal(graph["600"], undefined);
  // The retry twin is the same call on another seed.
  assert.equal(graph["612"]!.inputs["model.seed"], 1);
});

test("each mode asks the prompt model for its own masking task", () => {
  assert.ok(ref5Request("x", 0, "quality").endsWith(REF7_QUALITY_TASK));
  assert.match(REF7_QUALITY_TASK, /dummies/);
  assert.ok(ref5Request("x", 0, "light").endsWith(REF6_LIGHT_TASK));
  assert.match(REF6_LIGHT_TASK, /#FF0000/);
  assert.equal(
    buildLocalVideoGraph(input, { ...LIGHT, promptApi: "openrouter" }).graph["602"]!.inputs.user_prompt,
    ref5Request(input.prompt, 0, "light"),
  );
});

test("Light conditions both passes once, on the clip and the user's prompt", () => {
  const { graph } = buildLocalVideoGraph(input, LIGHT);
  // Prompt #1, through its blank check.
  assert.deepEqual(graph["705"]!.inputs.on_true, ["603", 0]);
  assert.deepEqual(graph["21"]!.inputs.prompt, ["705", 0]);
  // The clip, held to the 544p cap.
  assert.deepEqual(graph["21"]!.inputs["ref_videos.ref_video_0"], ["325", 0]);
  assert.deepEqual(graph["325"]!.inputs.input, ["320", 0]);
  assert.deepEqual(graph[REF5_PROMPT_NODE]!.inputs.source, ["705", 0]);
  assert.deepEqual(graph["7"]!.inputs.conditioning, ["21", 0]);
  assert.deepEqual(graph["22"]!.inputs.conditioning, ["21", 0]);
  assert.deepEqual(graph["11"]!.inputs.latent_image, ["21", 1]);
  // One conditioning: no recoloured prompt, colour pass or second call.
  assert.equal(ofType(graph, "MiniMaxH3ReferenceToVideo").length, 1);
  for (const id of ["30", "34", "604", "606"]) assert.equal(graph[id], undefined, id);
  // Light still loads the gear's OmniRef model and finishes on ref2va.
  assert.deepEqual(graph["6"]!.inputs.model, ["1", 0]);
});

test("Quality renders the dummies in one ref2va pass, then the characters in Light's two passes", () => {
  const { graph } = buildLocalVideoGraph({ ...input, images: [PNG, PNG] }, QUALITY);
  // The final render uses Light's setup: OmniRef, shifted, for pass 1 and the sheets...
  assert.deepEqual(graph["6"]!.inputs.model, ["1", 0]);
  for (const id of ["7", "404"]) assert.deepEqual(graph[id]!.inputs.model, ["17", 0], id);
  // ...and ref2va + Pika, unshifted, for pass 2.
  assert.deepEqual(graph["22"]!.inputs.model, ["19", 0]);
  assert.equal(graph["9"]!.inputs.sampler_name, "euler");

  // The dummy pass has its own shifted ref2va + Pika chain and lcm.
  assert.deepEqual(graph["26"]!.inputs.model, ["19", 0]);
  assert.equal(graph["26"]!.class_type, "MiniMaxH3SigmaShift");
  assert.deepEqual(graph["28"]!.inputs.model, ["27", 0]);
  assert.equal(graph["28"]!.inputs.selection, graph["17"]!.inputs.selection);
  assert.deepEqual(graph["31"]!.inputs.model, ["28", 0]);
  assert.equal(graph["29"]!.inputs.sampler_name, "lcm");
  assert.equal(graph["35"]!.inputs.sigmas, "1.0, 0.972973, 0.923077, 0.8, 0.571429, 0.333333, 0.0");

  // One prompt call: prompt #1 (dummies) and #2 (characters), each checked.
  assert.equal(graph["606"], undefined);
  assert.deepEqual(graph["705"]!.inputs.on_true, ["603", 0]);
  assert.deepEqual(graph["715"]!.inputs.on_true, ["604", 0]);

  // Dummies: one 6-step pass on the capped clip, decoded from the denoised estimate.
  assert.deepEqual(graph["30"]!.inputs.prompt, ["705", 0]);
  assert.deepEqual(graph["30"]!.inputs["ref_videos.ref_video_0"], ["325", 0]);
  assert.deepEqual(graph["33"]!.inputs, {
    noise: ["32", 0],
    guider: ["31", 0],
    sampler: ["29", 0],
    sigmas: ["35", 0],
    latent_image: ["30", 1],
  });
  assert.deepEqual(graph["34"]!.inputs.samples, ["33", 1]);
  for (const id of ["38", "39"]) assert.equal(graph[id], undefined, id);

  // Characters: two passes on the dummy render, with the sheets.
  assert.deepEqual(graph["21"]!.inputs.prompt, ["715", 0]);
  assert.deepEqual(graph["21"]!.inputs["ref_videos.ref_video_0"], ["34", 0]);
  assert.deepEqual(graph["21"]!.inputs["ref_images.ref_image_1"], ["424", 0]);
  assert.deepEqual(graph[REF5_PROMPT_NODE]!.inputs.source, ["715", 0]);
  assert.deepEqual(graph["11"]!.inputs.sigmas, ["20", 0]);
  assert.deepEqual(graph["11"]!.inputs.guider, ["7", 0]);
  assert.deepEqual(graph["25"]!.inputs.sigmas, ["24", 0]);
  assert.deepEqual(graph["25"]!.inputs.latent_image, ["11", 0]);
  assert.deepEqual(graph["22"]!.inputs.conditioning, ["21", 0]);

  // The prompt model: Gemini at high thinking by default, Kimi at xhigh when chosen.
  assert.equal(graph["602"]!.inputs["model.thinking_level"], "HIGH");
  assert.equal(buildLocalVideoGraph({ ...input, images: [PNG, PNG] }, QUALITY_KIMI).graph["602"]!.inputs.reasoning_effort, "xhigh");
});

test("Light keeps two passes: 6 of 24 steps on OmniRef, then ref2va on manual sigmas", () => {
  const { graph } = buildLocalVideoGraph(input, LIGHT);
  assert.equal(graph["9"]!.inputs.sampler_name, "euler");
  assert.equal(graph["10"]!.inputs.steps, 24);
  assert.equal(graph["20"]!.inputs.step, 6);
  assert.deepEqual(graph["11"]!.inputs.sigmas, ["20", 0]);
  assert.deepEqual(graph["7"]!.inputs.model, ["17", 0]);

  assert.equal(graph["19"]!.class_type, "LoraLoaderModelOnly");
  assert.equal(graph["19"]!.inputs.lora_name, "pika_h3_flex_ref2va_v1_bf16.safetensors");
  assert.deepEqual(graph["22"]!.inputs.model, ["19", 0]);
  assert.equal(graph["23"]!.class_type, "DisableNoise");
  assert.equal(graph["24"]!.inputs.sigmas, "0.972973, 0.923077, 0.8, 0.571429, 0.333333, 0.0");
  assert.deepEqual(graph["25"]!.inputs.sigmas, ["24", 0]);
  assert.deepEqual(graph["25"]!.inputs.latent_image, ["11", 0]);
  assert.equal(graph["15"]!.class_type, "SaveVideo");
});

test("character sheets keep the workflow's 8 steps, whatever the saved step count", () => {
  for (const files of [QUALITY, LIGHT]) {
    const { graph } = buildLocalVideoGraph({ ...input, images: [PNG] }, { ...files, steps: 30 });
    assert.equal(graph["404"]!.inputs.steps, 8);
  }
});

test("every regex output the graph uses is checked for blank, retried once, then guarded", () => {
  const cases = [
    [LIGHT, "603", "602", 700],
    [QUALITY, "603", "602", 700],
    [QUALITY, "604", "602", 710],
  ] as const;
  for (const [files, extractId, callId, base] of cases) {
    const { graph } = buildLocalVideoGraph(input, files);
    const at = (offset: number) => String(base + offset);
    const retryCall = String(Number(callId) + 10);

    // The retry twin is the same call on another seed. OpenRouter's seed is
    // its own input; Gemini's sits inside the model combo.
    const first = { ...graph[callId]!.inputs };
    const retry = { ...graph[retryCall]!.inputs };
    const seedKey = "seed" in first ? "seed" : "model.seed";
    const firstSeed = first[seedKey];
    const retrySeed = retry[seedKey];
    delete first[seedKey];
    delete retry[seedKey];
    assert.deepEqual(retry, first);
    assert.notEqual(retrySeed, firstSeed);

    // The check: does anything but whitespace come out of the regex?
    assert.equal(graph[at(0)]!.class_type, "RegexMatch");
    assert.deepEqual(graph[at(0)]!.inputs.string, [extractId, 0]);
    assert.equal(graph[at(0)]!.inputs.regex_pattern, "\\S");
    // The same regex on the retry's answer, and the same check on it.
    assert.deepEqual(graph[at(1)]!.inputs.string, [retryCall, 0]);
    assert.equal(graph[at(1)]!.inputs.regex_pattern, graph[extractId]!.inputs.regex_pattern);
    assert.deepEqual(graph[at(2)]!.inputs.string, [at(1), 0]);
    // A blank retry fails the guard, whose message the app pops up.
    assert.equal(graph[at(3)]!.class_type, "ComfyMathExpression");
    assert.deepEqual(graph[at(3)]!.inputs["values.a"], [at(2), 0]);
    assert.ok(isBlankPromptError(String(graph[at(3)]!.inputs.expression)));
    assert.deepEqual(graph[at(4)]!.inputs, { switch: [at(3), 2], on_true: [at(1), 0], on_false: [at(1), 0] });
    // First answer when it is not blank, else the guarded retry.
    assert.deepEqual(graph[at(5)]!.inputs, { switch: [at(0), 0], on_true: [extractId, 0], on_false: [at(4), 0] });
  }
});

test("a prompt model that answers blank twice is told apart from other failures", () => {
  const message = "The prompt model returned no usable prompt twice in a row, so the render was stopped.";
  const run = classicRunError({
    status: {
      status_str: "error",
      messages: [["execution_error", { exception_message: message, node_type: "OpenRouterStructuredOutputMultiTurn" }]],
    },
  })!;
  assert.equal(isBlankPromptError(run), true);
  assert.equal(isBlankPromptError("CUDA out of memory"), false);
});

test("the mode survives the settings normalizer and reaches the graph", () => {
  const env = (vars: Record<string, string>): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...vars });
  const saved = localModelConfig({ openjutsuMode: "light" });
  assert.equal(saved.openjutsuMode, "light");
  assert.equal(localFiles(saved, env({})).openjutsuMode, "light");
  // A gear saved before the rename still reads as Light.
  assert.equal(localModelConfig({ openjutsuMode: "flash" }).openjutsuMode, "light");

  // An unknown value, or a retired pass-2 setting, is dropped, and the graph
  // runs the default, Light.
  const broken = localModelConfig({ openjutsuMode: "turbo", secondPassSigmas: "low", secondPassModel: "omni" });
  assert.deepEqual(Object.keys(broken).sort(), ["clip", "refVideoEdge", "steps", "unet"]);
  const fallback = buildLocalVideoGraph(input, { ...localFiles(broken, env({})), openRouterKey: KEY });
  assert.equal(fallback.graph["21"]!.class_type, "MiniMaxH3ReferenceToVideo");
  assert.equal(fallback.graph["30"], undefined);
});

test("the clip's own sound is kept, and a silent clip hears silence", () => {
  const loud = buildLocalVideoGraph(input, QUALITY);
  assert.equal(loud.audioSource, "reference");
  assert.deepEqual(loud.graph["14"]!.inputs.audio, ["300", 2]);
  assert.deepEqual(loud.graph["21"]!.inputs["ref_video_audios.ref_video_audio_0"], ["300", 2]);
  assert.deepEqual(loud.graph["30"]!.inputs["ref_video_audios.ref_video_audio_0"], ["300", 2]);

  const quiet = buildLocalVideoGraph({ ...input, video: MP4 }, QUALITY);
  assert.equal(quiet.audioSource, "silent");
  assert.equal(quiet.graph["322"]!.class_type, "EmptyAudio");
  assert.deepEqual(quiet.graph["14"]!.inputs.audio, ["322", 0]);
});

test("the motion reference is scaled by area, like ComfyUI does", () => {
  assert.deepEqual(ref5Dimensions({ width: 1920, height: 1080 }, "480P"), { width: 864, height: 480, megapixels: 0.4 });
  assert.equal(ref5Dimensions({ width: 1920, height: 1080 }, "768P").megapixels, 1);
});

test("a missing node is reported by name, not as a bare node id", () => {
  const advice = /^Your ComfyUI has no H3WaitForConditioning node \(node #26\)\. Install/;

  // A deployment's failed job: only the id in the message, the class beside it.
  const job = Object.assign(new Error("job abc ended failed"), {
    error: { code: "invalid_workflow", message: "Node ID '#26'", node_id: "26", class_type: "H3WaitForConditioning" },
  });
  assert.match((localFailure(job) as Error).message, advice);

  // A refused submission carries the same on `details`.
  const refused = Object.assign(new Error("Node ID '#26'"), {
    details: { message: "Node ID '#26'", node_id: "26", class_type: "H3WaitForConditioning" },
  });
  assert.match((localFailure(refused) as Error).message, advice);

  // A bare ComfyUI's /prompt answer.
  assert.match(
    classicError({
      error: {
        type: "missing_node_type",
        message: "Node 'ID #26' not found. The custom node may not be installed.",
        details: "Node ID '#26'",
        extra_info: { node_id: "26", class_type: "H3WaitForConditioning" },
      },
    })!,
    advice,
  );

  // Other failures keep their own words.
  const other = Object.assign(new Error("job abc ended failed"), {
    error: { code: "execution_error", message: "CUDA out of memory", node_id: "11", class_type: "SamplerCustomAdvanced" },
  });
  assert.equal((localFailure(other) as Error).message, "CUDA out of memory");
});

test("the prompt H3 rendered is read off the preview node", () => {
  assert.equal(classicText({ "605": { text: ["  subject_definitions: x  "] } }, "605"), "subject_definitions: x");
  assert.equal(classicText({ "605": { text: [""] } }, "605"), undefined);
  assert.equal(classicText({}, "605"), undefined);
  assert.equal(classicText({ "605": { text: ["x"] } }, undefined), undefined);
});

test("Quality reads prompt #1 and prompt #2 from one answer, in order", () => {
  const { graph } = buildLocalVideoGraph(input, QUALITY);
  // What RegexExtract does: First Group, case-insensitive, dotall.
  const read = (id: string, text: string) =>
    new RegExp(String(graph[id]!.inputs.regex_pattern), "is").exec(text)?.[1] ?? "";
  const block = (name: string) => `subject_definitions:\n${name}\nsummary: x\nnon_diegetic_music:\nN/A\n`;
  const answer = `Prompt 1:\n${block("DUMMIES")}\nPrompt 2:\n${block("CHARACTERS")}`;
  assert.match(read("603", answer), /DUMMIES/);
  assert.match(read("604", answer), /CHARACTERS/);
});

test("with the upscale on, both modes end on a 2x upscale pass over the finished latent", () => {
  // Both modes finish on pass 2, and the refiner stacks on pass 2's ref2va chain.
  for (const [files, finished, refinerBase] of [[{ ...QUALITY, upscale: true }, "25", "19"], [{ ...LIGHT, upscale: true }, "25", "19"]] as const) {
    const plan = buildLocalVideoGraph(input, files);
    const { graph } = plan;
    assert.equal(graph["40"]!.class_type, "LatentUpscaleModelLoader");
    assert.equal(graph["40"]!.inputs.model_name, "minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors");
    // Twice the guide's real size, read in the graph since the border check may crop.
    assert.deepEqual(graph["41"]!.inputs, { expression: "a * 2", "values.a": ["321", 0] });
    assert.deepEqual(graph["42"]!.inputs, { expression: "a * 2", "values.a": ["321", 1] });
    assert.deepEqual(graph["43"]!.inputs, { model: ["40", 0], samples: [finished, 0], width: ["41", 1], height: ["42", 1] });

    // The finishing chain with the refiner appended, on the same conditioning.
    assert.deepEqual(graph["44"]!.inputs, { model: [refinerBase, 0], lora_name: OPENJUTSU_REFINER_LORAS[0], strength_model: 1 });
    assert.deepEqual(graph["45"]!.inputs, { model: ["44", 0], conditioning: ["21", 0] });
    assert.equal(graph["46"]!.class_type, "RandomNoise");
    // Below 1.0, so the upscaled latent is refined rather than replaced by noise.
    assert.equal(graph["47"]!.inputs.sigmas, "0.909375, 0.857143, 0.666667, 0");
    assert.deepEqual(graph["48"]!.inputs.latent_image, ["43", 0]);
    assert.deepEqual(graph["48"]!.inputs.guider, ["45", 0]);

    // The denoised estimate is what is saved, at twice the size.
    assert.deepEqual(graph["12"]!.inputs.samples, ["48", 1]);
    assert.deepEqual(graph["14"]!.inputs.images, ["12", 0]);
    const base = ref5Dimensions(undefined, input.resolution);
    assert.deepEqual([plan.width, plan.height], [base.width * 2, base.height * 2]);

    // The pre-upscale clip is saved first, at the render's own size, so a
    // failed upscale still has the generated video to fall back to.
    assert.equal(plan.fallbackNode, "37");
    assert.equal(graph["13"]!.class_type, "VAEDecode");
    // Pass 2's output in both modes.
    assert.deepEqual(graph["13"]!.inputs.samples, ["25", 0]);
    // The fallback save does not displace Quality's dummy pass.
    if (files.openjutsuMode !== "light") assert.equal(graph["33"]!.class_type, "SamplerCustomAdvanced");
    assert.deepEqual(graph["36"]!.inputs.images, ["13", 0]);
    assert.equal(graph["37"]!.class_type, "SaveVideo");
    assert.deepEqual(graph["37"]!.inputs.video, ["36", 0]);
    assert.match(String(graph["37"]!.inputs.filename_prefix), /_raw$/);
  }
});

test("the API toggle keeps Comfy (the default) implicit and only stores OR", () => {
  const env = (vars: Record<string, string>): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...vars });
  assert.equal(localModelConfig({}).promptApi, undefined);
  assert.equal(localModelConfig({ promptApi: "gemini" }).promptApi, undefined);
  assert.equal(localModelConfig({ promptApi: "openrouter" }).promptApi, "openrouter");
  assert.equal(localModelConfig({ promptApi: "nonsense" }).promptApi, undefined);
  assert.equal(localFiles(localModelConfig({ promptApi: "openrouter" }), env({})).promptApi, "openrouter");
});

test("with the upscale off (the default), the finished pass is decoded once and saved", () => {
  const env = (vars: Record<string, string>): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...vars });
  // Off is the default, so it is not stored; only an explicit on is.
  assert.equal(localModelConfig({ upscale: false }).upscale, undefined);
  assert.equal(localModelConfig({ upscale: true }).upscale, true);
  assert.equal(localModelConfig({}).upscale, undefined);

  const base = ref5Dimensions(undefined, input.resolution);
  // Both modes decode pass 2's output.
  for (const [mode, decoded] of [["quality", ["25", 0]], ["light", ["25", 0]]] as const) {
    const plan = buildLocalVideoGraph(input, {
      ...localFiles(localModelConfig({ openjutsuMode: mode }), env({})),
      openRouterKey: KEY,
    });
    for (const id of ["40", "41", "42", "43", "44", "45", "46", "47", "48", "36", "37"]) {
      assert.equal(plan.graph[id], undefined, id);
    }
    assert.equal(plan.fallbackNode, undefined);
    assert.deepEqual(plan.graph["13"]!.inputs.samples, decoded);
    assert.deepEqual(plan.graph["14"]!.inputs.images, ["13", 0]);
    assert.deepEqual([plan.width, plan.height], [base.width, base.height]);
  }
});

test("the video reference cap shrinks what H3 encodes, never the render", () => {
  const env = (vars: Record<string, string>): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...vars });
  const graphFor = (config: Record<string, unknown>) =>
    buildLocalVideoGraph(input, { ...localFiles(localModelConfig(config), env({})), openRouterKey: KEY }).graph;

  // Match output (the default) is still held to the 544p hard limit, as is
  // an older, bigger pick.
  for (const refVideoEdge of [0, 720]) {
    const plain = graphFor({ openjutsuMode: "light", refVideoEdge });
    assert.equal(plain["324"]!.inputs.expression, "min(a, b, 544)");
    assert.deepEqual(plain["21"]!.inputs["ref_videos.ref_video_0"], ["325", 0]);
  }
  assert.equal(localModelConfig({ refVideoEdge: 544 }).refVideoEdge, 544);

  // Light: one cap, on the clip.
  const light = graphFor({ openjutsuMode: "light", refVideoEdge: 360 });
  assert.deepEqual(light["324"]!.inputs, { expression: "min(a, b, 360)", "values.a": ["321", 0], "values.b": ["321", 1] });
  assert.deepEqual(light["325"]!.inputs, {
    input: ["320", 0],
    resize_type: "scale shorter dimension",
    "resize_type.shorter_size": ["324", 1],
    scale_method: "bicubic",
  });
  assert.deepEqual(light["21"]!.inputs["ref_videos.ref_video_0"], ["325", 0]);
  // The render keeps the guide's own size.
  assert.deepEqual([light["21"]!.inputs.width, light["21"]!.inputs.height], [["321", 0], ["321", 1]]);

  // Quality: the dummy pass takes the capped clip and renders at its size,
  // snapped onto H3's 32 px grid.
  const quality = graphFor({ openjutsuMode: "quality", refVideoEdge: 480 });
  assert.deepEqual(quality["30"]!.inputs["ref_videos.ref_video_0"], ["325", 0]);
  assert.deepEqual(quality["325"]!.inputs.input, ["320", 0]);
  assert.deepEqual(quality["323"]!.inputs, { image: ["325", 0] });
  assert.deepEqual(quality["328"]!.inputs, { expression: "max(32, floor(a / 32) * 32)", "values.a": ["323", 0] });
  assert.deepEqual(quality["329"]!.inputs, { expression: "max(32, floor(a / 32) * 32)", "values.a": ["323", 1] });
  assert.deepEqual([quality["30"]!.inputs.width, quality["30"]!.inputs.height], [["328", 1], ["329", 1]]);
  // The dummy render is already within the cap: the character pass takes it
  // as it is, renders at the guide's size, and samples its own latent.
  assert.deepEqual(quality["21"]!.inputs["ref_videos.ref_video_0"], ["34", 0]);
  assert.equal(quality["326"], undefined);
  assert.deepEqual([quality["21"]!.inputs.width, quality["21"]!.inputs.height], [["321", 0], ["321", 1]]);
  assert.deepEqual(quality["11"]!.inputs.latent_image, ["21", 1]);
  // The prompt model still watches the clip as it is.
  assert.deepEqual(quality["601"]!.inputs.images, ["320", 0]);

  // Match output: the dummy pass renders at the 544p-capped size too.
  const uncapped = graphFor({ openjutsuMode: "quality" });
  assert.equal(uncapped["324"]!.inputs.expression, "min(a, b, 544)");
  assert.deepEqual([uncapped["30"]!.inputs.width, uncapped["30"]!.inputs.height], [["328", 1], ["329", 1]]);
});

test("the upscale pass uses the refiner LoRA verify saved, either rank", () => {
  const env = (vars: Record<string, string>): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...vars });
  const saved = localModelConfig({ upscale: true, refinerLora: `H3\\${OPENJUTSU_REFINER_LORAS[1]}` });
  assert.equal(saved.refinerLora, `H3\\${OPENJUTSU_REFINER_LORAS[1]}`);
  const { graph } = buildLocalVideoGraph(input, { ...localFiles(saved, env({})), openRouterKey: KEY });
  assert.equal(graph["44"]!.inputs.lora_name, `H3\\${OPENJUTSU_REFINER_LORAS[1]}`);

  // Extras take any file name the target lists; only junk is dropped.
  assert.equal(localModelConfig({ refinerLora: "my_refiner.safetensors" }).refinerLora, "my_refiner.safetensors");
  assert.equal(localModelConfig({ refinerLora: "a\nb" }).refinerLora, undefined);
  assert.equal(localModelConfig({ refinerLora: "   " }).refinerLora, undefined);
});

test("Extras' second-pass model and LoRA reach the pass-2 chain", () => {
  const env = (vars: Record<string, string>): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...vars });
  const graphFor = (config: Record<string, unknown>) =>
    buildLocalVideoGraph(input, {
      ...localFiles(localModelConfig({ openjutsuMode: "quality", upscale: true, ...config }), env({})),
      openRouterKey: KEY,
    }).graph;
  const plain = graphFor({});
  assert.equal(plain["18"]!.inputs.unet_name, "minimax_h3_ref2va_pruned_int8_convrot.safetensors");
  assert.equal(plain["19"]!.inputs.lora_name, "pika_h3_flex_ref2va_v1_bf16.safetensors");
  const mine = graphFor({ ref2vaUnet: "my_ref2va.safetensors", ref2vaLora: "H3\\Pika-Labs\\pika.safetensors" });
  assert.equal(mine["18"]!.inputs.unet_name, "my_ref2va.safetensors");
  assert.equal(mine["19"]!.inputs.lora_name, "H3\\Pika-Labs\\pika.safetensors");
  // Pass 2 runs on them, and the upscale's refiner stacks on them.
  assert.deepEqual(mine["22"]!.inputs.model, ["19", 0]);
  assert.deepEqual(mine["44"]!.inputs.model, ["19", 0]);
});

test("Extras' latent upscaler replaces the default, and blank keeps it", () => {
  const env = (vars: Record<string, string>): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...vars });
  const run = (config: Record<string, unknown>) =>
    buildLocalVideoGraph(input, {
      ...localFiles(localModelConfig({ upscale: true, ...config }), env({})),
      openRouterKey: KEY,
    }).graph["40"]!.inputs.model_name;
  assert.equal(run({}), "minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors");
  assert.equal(run({ latentUpscaler: "  " }), "minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors");
  assert.equal(run({ latentUpscaler: "mine.safetensors" }), "mine.safetensors");
});
