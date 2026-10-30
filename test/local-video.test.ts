import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LOCAL_FILES,
  LOCAL_SAVE_NODE,
  buildLocalVideoGraph,
  classicAssetName,
  classicError,
  classicRunError,
  classicVideoRef,
  hasAudioTrack,
  classicViewUrl,
  localDimensions,
  localFiles,
  localFrames,
  mp4VideoSize,
  refVideoDimensions,
  splitDataUri,
  surfaceFromStatus,
} from "../lib/local-video.ts";
import { LOCAL_MODEL_DEFAULTS, VIDEO_RATIOS, localModelConfig } from "../lib/video.ts";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
const MP4 = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28y";
/** A header that names a `soun` track, the way an MP4 with audio does. */
const MP4_AUDIO = `data:video/mp4;base64,${Buffer.from("ftypisommoovtrakmdiahdlrsounmp4a").toString("base64")}`;

const env = (vars: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...vars });

test("the configuration names the loaders and the step count", () => {
  const config = { unet: "my-unet.safetensors", clip: "my-clip.safetensors", steps: 12 };
  const files = localFiles(config, env());

  assert.equal(files.unet, config.unet);
  assert.equal(files.clip, config.clip);
  assert.equal(files.steps, config.steps);

  const graph = buildLocalVideoGraph(
    { prompt: "x", mode: "free", ratio: "16:9", resolution: "768P", duration: 5 },
    files,
  ).graph;
  assert.equal(graph["1"]!.inputs.unet_name, config.unet);
  assert.equal(graph["2"]!.inputs.clip_name, config.clip);
  assert.equal(graph["10"]!.inputs.steps, 12);

  // The VAEs are not in the dialog, so they stay environment/default driven.
  assert.equal(files.videoVae, DEFAULT_LOCAL_FILES.videoVae);
  assert.equal(localFiles(config, env({ H3_VAE_VIDEO: "v.safetensors" })).videoVae, "v.safetensors");
});

test("a missing or partial config falls back to the defaults", () => {
  assert.deepEqual(localModelConfig(undefined), { ...LOCAL_MODEL_DEFAULTS });
  assert.deepEqual(localModelConfig({ unet: "  " }), { ...LOCAL_MODEL_DEFAULTS });
  assert.deepEqual(localModelConfig({ unet: "u", clip: "c", steps: 999 }), { unet: "u", clip: "c", steps: 200, refVideoEdge: 0 });
  assert.equal(localModelConfig({ steps: 0 }).steps, 1);
  assert.equal(localModelConfig({ steps: "nope" }).steps, LOCAL_MODEL_DEFAULTS.steps);
});

test("a free render is a graph with no loaders for media", () => {
  const plan = buildLocalVideoGraph({
    prompt: "a lighthouse in a storm",
    mode: "free",
    ratio: "16:9",
    resolution: "768P",
    duration: 6,
  });

  assert.equal(plan.width, 1344);
  assert.equal(plan.height, 768);
  assert.equal(plan.frames, 141);
  assert.deepEqual(plan.uploads, []);

  const h3 = plan.graph["5"];
  assert.ok(h3);
  assert.equal(h3.class_type, "MiniMaxH3ReferenceToVideo");
  assert.equal(h3.inputs.prompt, "a lighthouse in a storm");
  assert.equal(h3.inputs.width, 1344);
  assert.equal(h3.inputs.length, 141);
  assert.ok(!("ref_images.ref_image_0" in h3.inputs));

  assert.equal(plan.graph["1"]?.class_type, "UNETLoader");
  assert.equal(plan.graph["1"]?.inputs.unet_name, DEFAULT_LOCAL_FILES.unet);
  assert.equal(plan.graph[LOCAL_SAVE_NODE]?.class_type, "SaveVideo");
  assert.deepEqual(plan.graph[LOCAL_SAVE_NODE]?.inputs.video, ["14", 0]);
});

test("reference images and an audio bed become loader nodes", () => {
  const plan = buildLocalVideoGraph({
    prompt: "the character speaks",
    mode: "audio",
    ratio: "16:9",
    resolution: "768P",
    duration: 5,
    images: [PNG, PNG],
    audio: WAV,
  });

  assert.equal(plan.uploads.length, 3);
  assert.deepEqual(
    plan.uploads.map((upload) => [upload.nodeId, upload.field]),
    [
      ["100", "image"],
      ["101", "image"],
      ["200", "audio"],
    ],
  );

  const h3 = plan.graph["5"]!;
  assert.deepEqual(h3.inputs["ref_images.ref_image_0"], ["100", 0]);
  assert.deepEqual(h3.inputs["ref_images.ref_image_1"], ["101", 0]);
  assert.deepEqual(h3.inputs["ref_audios.ref_audio_0"], ["200", 0]);
  assert.equal(plan.graph["200"]?.class_type, "LoadAudio");

  // The uploaded track is the finished mix, so it goes straight into the
  // muxer; H3's own audio latents are not even decoded.
  assert.equal(plan.audioSource, "reference");
  assert.deepEqual(plan.graph["14"]?.inputs.audio, ["200", 0]);
  assert.equal(plan.graph["13"], undefined);
});

test("a first frame selects the image-to-video graph", () => {
  const plan = buildLocalVideoGraph({
    prompt: "push in on the mouse",
    mode: "free",
    ratio: "16:9",
    resolution: "768P",
    duration: 5,
    firstFrame: PNG,
  });

  assert.equal(plan.uploads.length, 1);
  assert.deepEqual(
    [plan.uploads[0]!.nodeId, plan.uploads[0]!.field, plan.uploads[0]!.kind],
    ["100", "image", "image"],
  );
  assert.equal(plan.graph["100"]?.class_type, "LoadImage");

  const h3 = plan.graph["5"]!;
  assert.equal(h3.class_type, "MiniMaxH3ImageToVideo");
  assert.deepEqual(h3.inputs.first_frame, ["100", 0]);
  assert.ok(!("last_frame" in h3.inputs));
  assert.ok(!("audio_vae" in h3.inputs));
  assert.ok(!("ref_image_size" in h3.inputs));
  assert.equal(h3.inputs.length, 124);

  // The i2v template runs the checkpoint bare and samples res_multistep.
  assert.equal(plan.graph["6"], undefined);
  assert.deepEqual(plan.graph["7"]!.inputs.model, ["1", 0]);
  assert.deepEqual(plan.graph["10"]!.inputs.model, ["1", 0]);
  assert.equal(plan.graph["9"]!.inputs.sampler_name, "res_multistep");
  assert.deepEqual(plan.graph["11"]!.inputs.latent_image, ["5", 1]);

  // A free render still decodes H3's own audio latents.
  assert.equal(plan.audioSource, "generated");
  assert.deepEqual(plan.graph["14"]?.inputs.audio, ["13", 0]);
});

test("a last frame alone also selects the image-to-video graph", () => {
  const plan = buildLocalVideoGraph({
    prompt: "settle here",
    mode: "free",
    ratio: "1:1",
    resolution: "480P",
    duration: 5,
    lastFrame: PNG,
  });

  assert.deepEqual(plan.uploads.map((upload) => upload.nodeId), ["101"]);
  const h3 = plan.graph["5"]!;
  assert.equal(h3.class_type, "MiniMaxH3ImageToVideo");
  assert.deepEqual(h3.inputs.last_frame, ["101", 0]);
  assert.ok(!("first_frame" in h3.inputs));
});

test("first and last frames ride one graph, and win over references", () => {
  const plan = buildLocalVideoGraph({
    prompt: "both ends pinned",
    mode: "free",
    ratio: "16:9",
    resolution: "768P",
    duration: 5,
    images: [PNG],
    firstFrame: PNG,
    lastFrame: PNG,
  });

  // Keyframes win, as on Router: the reference image is dropped.
  assert.deepEqual(
    plan.uploads.map((upload) => upload.nodeId),
    ["100", "101"],
  );
  const h3 = plan.graph["5"]!;
  assert.deepEqual(h3.inputs.first_frame, ["100", 0]);
  assert.deepEqual(h3.inputs.last_frame, ["101", 0]);
  assert.ok(!("ref_images.ref_image_0" in h3.inputs));
});

test("keyframes are ignored outside free mode", () => {
  const plan = buildLocalVideoGraph({
    prompt: "the character speaks",
    mode: "audio",
    ratio: "16:9",
    resolution: "768P",
    duration: 5,
    images: [PNG],
    audio: WAV,
    firstFrame: PNG,
    lastFrame: PNG,
  });

  assert.equal(plan.graph["5"]!.class_type, "MiniMaxH3ReferenceToVideo");
  assert.ok(!("first_frame" in plan.graph["5"]!.inputs));
  assert.ok(!("last_frame" in plan.graph["5"]!.inputs));
  assert.deepEqual(plan.graph["5"]!.inputs["ref_images.ref_image_0"], ["100", 0]);
});

test("a motion reference becomes a LoadVideo node", () => {
  const plan = buildLocalVideoGraph({
    prompt: "match the motion",
    mode: "video",
    ratio: "16:9",
    resolution: "768P",
    duration: 5,
    video: MP4,
  });

  assert.equal(plan.uploads.length, 1);
  assert.deepEqual(
    [plan.uploads[0]!.nodeId, plan.uploads[0]!.field, plan.uploads[0]!.kind],
    ["300", "file", "video"],
  );
  assert.equal(plan.graph["300"]?.class_type, "LoadVideo");
  // H3 wants frames, so the clip is split, scaled to the render size, and fed
  // to the reference input.
  assert.equal(plan.graph["301"]?.class_type, "GetVideoComponents");
  assert.deepEqual(plan.graph["301"]?.inputs.video, ["300", 0]);
  assert.equal(plan.graph["303"]?.class_type, "ImageScale");
  assert.deepEqual(plan.graph["303"]?.inputs, {
    image: ["301", 0],
    upscale_method: "lanczos",
    width: plan.width,
    height: plan.height,
    crop: "center",
  });
  assert.deepEqual(plan.graph["5"]!.inputs["ref_videos.ref_video_0"], ["303", 0]);

  // This fixture has no `soun` track, so there is nothing to carry through:
  // the clip keeps H3's generated audio.
  assert.equal(plan.audioSource, "generated");
  assert.deepEqual(plan.graph["14"]?.inputs.audio, ["13", 0]);
});

/** The smallest MP4 header `mp4VideoSize` reads: one 92-byte `tkhd` with a size. */
function mp4WithSize(width: number, height: number) {
  const box = new Uint8Array(92);
  const view = new DataView(box.buffer);
  view.setUint32(0, 92);
  box.set([0x74, 0x6b, 0x68, 0x64], 4);
  view.setUint32(84, width * 65536);
  view.setUint32(88, height * 65536);
  return `data:video/mp4;base64,${Buffer.from(box).toString("base64")}`;
}

test("a reference cap scales the guide without touching the output", () => {
  const input = { prompt: "x", mode: "video" as const, ratio: "16:9", resolution: "768P" as const, duration: 5, video: MP4 };
  const plan = buildLocalVideoGraph(input, { ...DEFAULT_LOCAL_FILES, refVideoEdge: 480 });

  assert.deepEqual([plan.width, plan.height], [1344, 768]);
  assert.deepEqual([plan.graph["5"]!.inputs.width, plan.graph["5"]!.inputs.height], [1344, 768]);
  assert.deepEqual([plan.graph["303"]!.inputs.width, plan.graph["303"]!.inputs.height], [832, 480]);
  assert.deepEqual(refVideoDimensions(1344, 768, 0), { width: 1344, height: 768 });
  // A cap above the output still raises the guide, rounded down onto the grid.
  assert.deepEqual(refVideoDimensions(768, 1344, 1080), { width: 1072, height: 1888 });
});

test("a clip smaller than the output or the cap is never upscaled", () => {
  const input = { prompt: "x", mode: "video" as const, ratio: "16:9", resolution: "768P" as const, duration: 5 };
  const guide = (video: string, refVideoEdge = 0) => {
    const node = buildLocalVideoGraph({ ...input, video }, { ...DEFAULT_LOCAL_FILES, refVideoEdge }).graph["303"]!;
    return [node.inputs.width, node.inputs.height];
  };

  // 288p clip, "match output": stays at 288p instead of being blown up to 768.
  assert.deepEqual(guide(mp4WithSize(512, 288)), [496, 288]);
  // 288p clip under a 720p cap: still its own size.
  assert.deepEqual(guide(mp4WithSize(512, 288), 720), [496, 288]);
  // 1080p clip: the output's size, or the cap, whichever is asked for.
  assert.deepEqual(guide(mp4WithSize(1920, 1080)), [1344, 768]);
  assert.deepEqual(guide(mp4WithSize(1920, 1080), 480), [832, 480]);
  // A size the container does not give (WebM, or junk) scales as before.
  assert.deepEqual(guide(MP4), [1344, 768]);

  assert.deepEqual(mp4VideoSize(Buffer.from(mp4WithSize(1376, 768).split(",")[1]!, "base64")), { width: 1376, height: 768 });
  assert.equal(mp4VideoSize(new Uint8Array(16)), undefined);
});

test("the reference edge survives the config round trip, and odd values fall back", () => {
  assert.equal(localModelConfig({ refVideoEdge: 720 }).refVideoEdge, 720);
  assert.equal(localModelConfig({ refVideoEdge: "576" }).refVideoEdge, 576);
  assert.equal(localModelConfig({ refVideoEdge: 333 }).refVideoEdge, 0);
  assert.equal(localModelConfig(undefined).refVideoEdge, 0);
  assert.equal(localFiles(localModelConfig({ refVideoEdge: 360 }), env({})).refVideoEdge, 360);
});

test("a motion reference with its own sound keeps that sound", () => {
  const plan = buildLocalVideoGraph({
    prompt: "match the motion",
    mode: "video",
    ratio: "16:9",
    resolution: "768P",
    duration: 5,
    video: MP4_AUDIO,
  });

  assert.equal(plan.audioSource, "reference");
  assert.deepEqual(plan.graph["5"]!.inputs["ref_videos.ref_video_0"], ["303", 0]);
  // `audio` is the second output of GetVideoComponents, after `images`.
  assert.deepEqual(plan.graph["14"]?.inputs.audio, ["301", 1]);
  assert.equal(plan.graph["13"], undefined);
});

test("a continuation hands H3 only the tail of the clip", () => {
  const plan = buildLocalVideoGraph({
    prompt: "keep walking",
    mode: "video",
    ratio: "16:9",
    resolution: "768P",
    duration: 5,
    video: MP4_AUDIO,
    continuation: true,
  });

  // The clip is split once, then read from its last 22 frames: a negative
  // batch index means the graph never has to know how long the clip is.
  assert.equal(plan.graph["302"]?.class_type, "ImageFromBatch");
  assert.deepEqual(plan.graph["302"]?.inputs, {
    image: ["301", 0],
    batch_index: -22,
    length: 22,
    allow_negative_index: true,
  });
  // The tail is then scaled like any other guide.
  assert.deepEqual(plan.graph["303"]?.inputs.image, ["302", 0]);
  assert.deepEqual(plan.graph["5"]!.inputs["ref_videos.ref_video_0"], ["303", 0]);

  // A continuation renders new content, so its sound is freshly decoded from
  // H3's audio latents — not the source clip's track carried through.
  assert.equal(plan.audioSource, "generated");
  assert.equal(plan.graph["13"]?.class_type, "VAEDecodeAudio");
  assert.deepEqual(plan.graph["14"]?.inputs.audio, ["13", 0]);
});

test("only a continuation trims the reference", () => {
  const plain = buildLocalVideoGraph({
    prompt: "match the motion",
    mode: "video",
    ratio: "16:9",
    resolution: "768P",
    duration: 5,
    video: MP4_AUDIO,
  });

  assert.equal(plain.graph["302"], undefined);
  assert.deepEqual(plain.graph["5"]!.inputs["ref_videos.ref_video_0"], ["303", 0]);
});

test("hasAudioTrack reads the container header", () => {
  assert.equal(hasAudioTrack(new Uint8Array(Buffer.from("ftypisomhdrsounmp4a"))), true);
  assert.equal(hasAudioTrack(new Uint8Array(Buffer.from("ftypisomhdravc1"))), false);
  assert.equal(hasAudioTrack(new Uint8Array(Buffer.from("webmvierA_OPUS\u0000"))), true);
  assert.equal(hasAudioTrack(new Uint8Array()), false);
});

test("audio is ignored outside audio mode, and images are capped", () => {
  const plan = buildLocalVideoGraph({
    prompt: "text only",
    mode: "free",
    ratio: "16:9",
    resolution: "768P",
    duration: 5,
    images: [PNG, PNG, PNG, PNG, PNG],
    audio: WAV,
  });

  assert.equal(plan.uploads.length, 4);
  assert.ok(!("ref_audios.ref_audio_0" in plan.graph["5"]!.inputs));
  assert.equal(plan.graph["104"], undefined);
  assert.equal(plan.audioSource, "generated");
  assert.equal(plan.graph["13"]?.class_type, "VAEDecodeAudio");
  assert.deepEqual(plan.graph["14"]?.inputs.audio, ["13", 0]);
});

test("frame counts and sizes stay inside the model's limits", () => {
  assert.equal(localFrames(5), 124);
  assert.equal(localFrames(99), 362);
  // The provider floor is four seconds, which still lands on the 124 floor.
  assert.equal(localFrames(1), 124);

  // Every length sits on H3's 5 + 17k grid inside the trained 124–362 range.
  for (let seconds = 5; seconds <= 15; seconds += 1) {
    const frames = localFrames(seconds);
    assert.equal((frames - 5) % 17, 0, `${seconds}s → ${frames}`);
    assert.ok(frames >= 124 && frames <= 362, `${seconds}s → ${frames}`);
  }

  assert.deepEqual(localDimensions("16:9"), { width: 1344, height: 768 });
  assert.deepEqual(localDimensions("nonsense"), { width: 1344, height: 768 });
});

test("every offered ratio has a grid-aligned size for the local graph", () => {
  for (const resolution of ["768P", "480P"] as const) {
    const ceiling = resolution === "768P" ? [700_000, 1_250_000] : [100_000, 500_000];

    for (const ratio of VIDEO_RATIOS) {
      const { width, height } = localDimensions(ratio.id, resolution);
      const label = `${resolution} ${ratio.id}`;
      assert.equal(width % 32, 0, `${label} width ${width}`);
      assert.equal(height % 32, 0, `${label} height ${height}`);
      // Each size keeps a steady pixel budget, so cost does not swing by ratio.
      assert.ok(width * height > ceiling[0] && width * height < ceiling[1], `${label} area`);

      if (ratio.id === "adaptive") {
        const expected = resolution === "768P" ? { width: 1344, height: 768 } : { width: 864, height: 480 };
        assert.deepEqual({ width, height }, expected, label);
        continue;
      }
      // The shape has to be right, allowing for the 32-pixel snap.
      assert.ok(Math.abs(width / height - ratio.w / ratio.h) < 0.06, `${label} shape`);
    }
  }

  assert.deepEqual(localDimensions("9:16"), { width: 768, height: 1344 });
  assert.deepEqual(localDimensions("3:4"), { width: 864, height: 1152 });
  assert.deepEqual(localDimensions("4:3"), { width: 1152, height: 864 });
  assert.deepEqual(localDimensions("16:9", "480P"), { width: 864, height: 480 });
  assert.deepEqual(localDimensions("9:16", "480P"), { width: 480, height: 864 });
});

test("the endpoint's surface is read off one probe", () => {
  // A bare ComfyUI: the v2 route is absent (404) or its static fallback
  // refuses the POST (405) — that second one is the "HTTP 405" people report.
  assert.equal(surfaceFromStatus(404), "classic");
  assert.equal(surfaceFromStatus(405), "classic");
  // A deployment answers, even when it wants a key.
  assert.equal(surfaceFromStatus(200), "v2");
  assert.equal(surfaceFromStatus(401), "v2");
  assert.equal(surfaceFromStatus(403), "v2");
});

test("a classic upload names the file its loader will read", () => {
  assert.equal(classicAssetName({ name: "ref.png", subfolder: "" }, "fallback.png"), "ref.png");
  assert.equal(classicAssetName({ name: "ref.png", subfolder: "cinematic" }, "fallback.png"), "cinematic/ref.png");
  // No answer body: the name we uploaded under is the one to use.
  assert.equal(classicAssetName(undefined, "fallback.png"), "fallback.png");
});

test("a rejected graph reports ComfyUI's own reason", () => {
  assert.equal(classicError({ error: { message: "Prompt outputs failed validation", details: "bad ratio" } }), "Prompt outputs failed validation: bad ratio");
  assert.equal(classicError({ error: "out of memory" }), "out of memory");
  assert.equal(
    classicError({
      node_errors: { "5": { errors: [{ message: "Required input is missing: prompt" }, { message: "bad width" }] } },
    }),
    "Required input is missing: prompt; bad width",
  );
  assert.equal(classicError({}), undefined);
  assert.equal(classicError(undefined), undefined);
});

test("a failed run is read off the history status", () => {
  assert.equal(
    classicRunError({
      status: {
        status_str: "error",
        messages: [["execution_start", {}], ["execution_error", { node_type: "SaveVideo", exception_message: "No space left" }]],
      },
    }),
    "SaveVideo: No space left",
  );
  assert.equal(classicRunError({ status: { status_str: "error", messages: [] } }), "The local graph failed while running.");
  assert.equal(classicRunError({ status: { status_str: "success", completed: true } }), undefined);
  assert.equal(classicRunError(undefined), undefined);
});

test("the saved file is found whichever key the save node uses", () => {
  const file = { filename: "h3_local_00001.mp4", subfolder: "cinematic", type: "output" };
  // Current ComfyUI reports SaveVideo under `images`; older packs use gifs.
  assert.deepEqual(classicVideoRef({ [LOCAL_SAVE_NODE]: { images: [file] } }), file);
  assert.deepEqual(classicVideoRef({ [LOCAL_SAVE_NODE]: { gifs: [file] } }), file);
  assert.deepEqual(classicVideoRef({ [LOCAL_SAVE_NODE]: { videos: [file] } }), file);
  // A run that saved a preview image only is not a clip.
  assert.equal(classicVideoRef({ [LOCAL_SAVE_NODE]: { images: [{ filename: "" }] } }), undefined);
  assert.equal(classicVideoRef({ "14": { images: [file] } }), undefined);
  assert.equal(classicVideoRef(undefined), undefined);

  // Defaults: no subfolder, and output rather than temp.
  assert.deepEqual(classicVideoRef({ [LOCAL_SAVE_NODE]: { images: [{ filename: "a.mp4" }] } }), {
    filename: "a.mp4",
    subfolder: "",
    type: "output",
  });
});

test("the download address is a /view query", () => {
  const url = classicViewUrl("http://192.168.0.10:8188/", {
    filename: "h3 local.mp4",
    subfolder: "cinematic",
    type: "output",
  });
  assert.equal(url, "http://192.168.0.10:8188/view?filename=h3+local.mp4&subfolder=cinematic&type=output");
});

test("data URIs decode to bytes and a name", () => {
  const image = splitDataUri(PNG);
  assert.equal(image.contentType, "image/png");
  assert.equal(image.filename, "reference.png");
  assert.ok(image.bytes.byteLength > 0);

  const audio = splitDataUri(WAV);
  assert.equal(audio.contentType, "audio/wav");
  assert.equal(audio.filename, "reference.wav");

  assert.throws(() => splitDataUri("not a data uri"));
  assert.throws(() => splitDataUri("data:image/png;base64,"));
});

test("each upload gets its own filename", () => {
  // A classic ComfyUI stores uploads by name with `overwrite`, so two stills
  // that both arrived as `reference.jpeg` left only the second on disk — the
  // canvas silently became a copy of the reference.
  const canvas = splitDataUri(PNG, "image_54");
  const reference = splitDataUri(PNG, "image_100");
  assert.equal(canvas.filename, "image_54.png");
  assert.equal(reference.filename, "image_100.png");
  assert.notEqual(canvas.filename, reference.filename);
});
