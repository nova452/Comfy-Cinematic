import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LOCAL_IMAGE_FILES,
  LOCAL_IMAGE_SAVE_NODE,
  LOCAL_IMAGE_SIZE,
  buildLocalImageEditGraph,
  buildLocalImageGraph,
  buildLocalImagePlan,
  classicImageRefs,
  localImageDimensions,
  localImageFiles,
} from "../lib/local-image.ts";
import {
  DEFAULT_TOOL,
  LOCAL_IMAGE_DEFAULTS,
  TOOLS,
  findImageTool,
  localImageModelConfig,
} from "../lib/harness.ts";

const env = (vars: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...vars });
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("a missing or partial config falls back to the defaults", () => {
  assert.deepEqual(localImageModelConfig(undefined), { ...LOCAL_IMAGE_DEFAULTS });
  assert.deepEqual(localImageModelConfig({ unet: "  " }), { ...LOCAL_IMAGE_DEFAULTS });
  assert.deepEqual(localImageModelConfig({ unet: "u", clip: "c", steps: 999 }), { unet: "u", clip: "c", steps: 200 });
  assert.equal(localImageModelConfig({ steps: 0 }).steps, 1);
  assert.equal(localImageModelConfig({ steps: "nope" }).steps, LOCAL_IMAGE_DEFAULTS.steps);
});

test("the graph is the FLUX 3 Klein stack on the 1k square grid", () => {
  const graph = buildLocalImageGraph({ prompt: "a lighthouse in a storm" });

  assert.equal(graph["1"]!.class_type, "UNETLoader");
  assert.equal(graph["1"]!.inputs.unet_name, DEFAULT_LOCAL_IMAGE_FILES.unet);
  assert.equal(DEFAULT_LOCAL_IMAGE_FILES.unet, "flux3-image-klein-int8-convrot0.safetensors");
  assert.equal(graph["2"]!.class_type, "CLIPLoader");
  assert.equal(graph["2"]!.inputs.clip_name, "qwen3vl_4b_fp8_scaled.safetensors");
  assert.equal(graph["2"]!.inputs.type, "flux3");
  assert.equal(graph["3"]!.class_type, "VAELoader");
  assert.equal(graph["3"]!.inputs.vae_name, "flux2-vae.safetensors");
  assert.equal(graph["4"]!.inputs.text, "a lighthouse in a storm");
  assert.equal(graph["5"]!.class_type, "ConditioningZeroOut");
  assert.equal(graph["6"]!.class_type, "EmptyFlux2LatentImage");
  assert.equal(graph["6"]!.inputs.width, LOCAL_IMAGE_SIZE);
  assert.equal(graph["6"]!.inputs.height, LOCAL_IMAGE_SIZE);
  assert.equal(graph["7"]!.class_type, "KSampler");
  assert.equal(graph["7"]!.inputs.steps, DEFAULT_LOCAL_IMAGE_FILES.steps);
  assert.equal(graph[LOCAL_IMAGE_SAVE_NODE]!.class_type, "SaveImage");
  assert.deepEqual(graph[LOCAL_IMAGE_SAVE_NODE]!.inputs.images, ["8", 0]);
});

test("the dialog values reach the loaders, the VAE stays environment driven", () => {
  const config = { unet: "my-unet.safetensors", clip: "my-text-encoder.safetensors", steps: 12 };
  const files = localImageFiles(config, env());

  assert.equal(files.unet, config.unet);
  assert.equal(files.clip, config.clip);
  assert.equal(files.steps, config.steps);
  assert.equal(files.vae, DEFAULT_LOCAL_IMAGE_FILES.vae);
  assert.equal(localImageFiles(config, env({ FLUX_VAE: "v.safetensors" })).vae, "v.safetensors");

  const graph = buildLocalImageGraph({ prompt: "x" }, files);
  assert.equal(graph["1"]!.inputs.unet_name, config.unet);
  assert.equal(graph["2"]!.inputs.clip_name, config.clip);
  assert.equal(graph["7"]!.inputs.steps, 12);
});

test("the seed is a parameter, so a render is reproducible", () => {
  const first = buildLocalImageGraph({ prompt: "x" }, DEFAULT_LOCAL_IMAGE_FILES, 7);
  const second = buildLocalImageGraph({ prompt: "x" }, DEFAULT_LOCAL_IMAGE_FILES, 7);

  assert.deepEqual(first, second);
  assert.equal(first["7"]!.inputs.seed, 7);
});

test("a ratio and size class become grid-aligned dimensions", () => {
  assert.deepEqual(localImageDimensions("1:1", "1k"), { width: 1024, height: 1024 });
  assert.deepEqual(localImageDimensions("16:9", "1k"), { width: 1360, height: 768 });
  // Auto follows a reference on Router; a local graph has none, so square.
  assert.deepEqual(localImageDimensions("auto", "2k"), { width: 2048, height: 2048 });

  const tall = localImageDimensions("9:16", "4k");
  assert.ok(tall.height > tall.width);
  assert.equal(tall.width % 16, 0);
  assert.equal(tall.height % 16, 0);
  assert.ok(Math.abs(tall.width / tall.height - 9 / 16) < 0.02);
});

test("a batch rides on EmptyFlux2LatentImage", () => {
  const graph = buildLocalImageGraph({ prompt: "x", ratio: "16:9", resolution: "2k", batch: 4 });
  assert.equal(graph["6"]!.inputs.batch_size, 4);
  assert.deepEqual(
    { width: graph["6"]!.inputs.width, height: graph["6"]!.inputs.height },
    { width: 2736, height: 1536 },
  );

  // A stale 9 clamps to the schema's ceiling rather than reaching the graph.
  assert.equal(buildLocalImageGraph({ prompt: "x", batch: 9 })["6"]!.inputs.batch_size, 4);
  assert.equal(buildLocalImageGraph({ prompt: "x", batch: 0 })["6"]!.inputs.batch_size, 1);
});

test("a batched save node reports every file", () => {
  const refs = classicImageRefs({
    [LOCAL_IMAGE_SAVE_NODE]: {
      images: [
        { filename: "a.png", subfolder: "cinematic", type: "output" },
        { filename: "b.png", subfolder: "cinematic", type: "output" },
      ],
    },
  });

  assert.deepEqual(
    refs.map((ref) => ref.filename),
    ["a.png", "b.png"],
  );
  assert.deepEqual(classicImageRefs({}), []);
});

test("canvas mode builds the FLUX 3 Klein edit graph", () => {
  const plan = buildLocalImageEditGraph({
    prompt: "change the dress to red",
    canvas: PNG,
    images: [PNG],
    resolution: "2k",
  });

  assert.equal(plan.graph["54"]!.class_type, "LoadImage");
  // The canvas is image 0 and further references follow it, the slots the
  // workflow's own ReferenceMultiLatent node offers.
  assert.deepEqual(
    plan.uploads.map((upload) => [upload.nodeId, upload.field]),
    [
      ["54", "image"],
      ["100", "image"],
    ],
  );

  const latent = plan.graph["17"]!;
  assert.equal(latent.class_type, "ReferenceMultiLatent");
  assert.equal(latent.inputs.resolution, "resize");
  assert.equal(latent.inputs["resolution.megapixels"], 4.2);
  assert.deepEqual(latent.inputs["images.image0"], ["54", 0]);
  assert.deepEqual(latent.inputs["images.image1"], ["100", 0]);

  const sampler = plan.graph["7"]!;
  assert.deepEqual(sampler.inputs.positive, ["17", 0]);
  assert.deepEqual(sampler.inputs.negative, ["17", 1]);
  assert.deepEqual(sampler.inputs.latent_image, ["17", 2]);
  assert.equal(plan.graph[LOCAL_IMAGE_SAVE_NODE]!.inputs.filename_prefix, "cinematic/flux3_klein_edit");
});

test("only a canvas selects the edit graph", () => {
  assert.deepEqual(buildLocalImagePlan({ prompt: "x" }).uploads, []);
  assert.equal(buildLocalImagePlan({ prompt: "x", canvas: PNG }).graph["17"]?.class_type, "ReferenceMultiLatent");
});

test("the registry pairs a Router FLUX 3 with its local twin", () => {
  assert.equal(DEFAULT_TOOL.provider, "router");
  assert.deepEqual(
    TOOLS.map((tool) => tool.id),
    ["bfl/flux-3-image", "local/flux-3-image"],
  );
  assert.equal(findImageTool("local/flux-3-image")?.provider, "local");
});
