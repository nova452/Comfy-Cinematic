import assert from "node:assert/strict";
import test from "node:test";
import { parseVideoPrompt } from "../lib/brain.ts";
import { composePrompt, CHARACTERS_CLAUSE, CHARACTER_CLAUSE } from "../lib/harness.ts";
import {
  DEFAULT_VIDEO_MODEL,
  VIDEO_MODES,
  VIDEO_MODELS,
  VIDEO_RATIOS,
  buildVideoRequest,
  clampDuration,
  durationOptions,
  findVideoModel,
  findVideoRatio,
  findVideoResolution,
  h3TierModels,
  isReferenceCaption,
  lockedByMode,
  ratioOptions,
  resolutionOptions,
  snapWindow,
  standaloneVideoModels,
  usesKeyframes,
  videoRatioLabel,
  videoResultError,
  videoResultUrl,
} from "../lib/video.ts";

test("minimax h3 is the registered video model", () => {
  assert.equal(DEFAULT_VIDEO_MODEL.id, "minimax/minimax-h3");
  assert.equal(findVideoModel("minimax/minimax-h3")?.label, "MiniMax H3");
  assert.equal(findVideoModel("nope"), undefined);
  assert.deepEqual(
    DEFAULT_VIDEO_MODEL.modes,
    VIDEO_MODES.map((mode) => mode.id),
  );
  assert.equal(DEFAULT_VIDEO_MODEL.provider, "router");
  assert.equal(VIDEO_MODELS.length, 4);
});

test("the h3 card groups three router tiers, original first", () => {
  const tiers = h3TierModels();
  assert.deepEqual(
    tiers.map((tier) => tier.label),
    ["Original", "Max", "Turbo"],
  );
  assert.deepEqual(
    tiers.map((tier) => tier.model.id),
    ["minimax/minimax-h3", "fal/h3-max", "fal/h3-max-turbo"],
  );
  assert.ok(tiers.every((tier) => tier.model.family === "MiniMax H3"));
  // Only the local graph sits outside the card.
  assert.deepEqual(
    standaloneVideoModels().map((model) => model.id),
    ["local/minimax-h3"],
  );
});

test("the fal tiers take a prompt only, in fal's own shapes", () => {
  for (const id of ["fal/h3-max", "fal/h3-max-turbo"]) {
    const model = findVideoModel(id)!;
    assert.equal(model.api, "fal");
    assert.equal(model.references, false);
    assert.deepEqual(model.modes, ["free"]);
    assert.deepEqual(model.resolutions, ["480P", "768P"]);
    assert.deepEqual(
      ratioOptions(model).map((ratio) => ratio.id),
      ["9:16", "16:9", "1:1"],
    );
    // A stale 4:3 selection clamps into this tier's set instead of a 422.
    assert.equal(findVideoRatio("4:3", model.ratio, model.ratios).id, "16:9");
  }
});

test("the local h3 keeps every reference mode", () => {
  const local = findVideoModel("local/minimax-h3");
  assert.ok(local);
  assert.equal(local.provider, "local");
  assert.equal(local.label, "MiniMax H3 Local");
  assert.deepEqual(local.modes, ["free", "audio", "video"]);
  assert.equal(local.ratio, DEFAULT_VIDEO_MODEL.ratio);
  assert.equal(local.resolution, DEFAULT_VIDEO_MODEL.resolution);
  assert.ok(VIDEO_MODELS.every((model) => model.provider === (model.id.startsWith("local/") ? "local" : "router")));
  assert.equal(new Set(VIDEO_MODELS.map((model) => model.id)).size, VIDEO_MODELS.length);
});

test("each h3 entry offers only the resolutions it can actually take", () => {
  // Router rejects everything but these two spellings with a 400.
  assert.deepEqual(DEFAULT_VIDEO_MODEL.resolutions, ["768P", "2K"]);
  const local = findVideoModel("local/minimax-h3")!;
  assert.deepEqual(local.resolutions, ["480P", "768P"]);

  assert.equal(findVideoResolution("2K", DEFAULT_VIDEO_MODEL.resolution, DEFAULT_VIDEO_MODEL.resolutions), "2K");
  assert.equal(findVideoResolution("2k", DEFAULT_VIDEO_MODEL.resolution, DEFAULT_VIDEO_MODEL.resolutions), "2K");
  // 480P is not in Router's set, so it clamps rather than being sent.
  assert.equal(findVideoResolution("480P", DEFAULT_VIDEO_MODEL.resolution, DEFAULT_VIDEO_MODEL.resolutions), "768P");
  // ...and 2K is not in the local graph's set, so the same clamp runs the other way.
  assert.equal(findVideoResolution("2K", local.resolution, local.resolutions), "768P");
  assert.equal(findVideoResolution("480p", local.resolution, local.resolutions), "480P");

  for (const model of VIDEO_MODELS) {
    const offered = resolutionOptions(model).map((option) => option.id);
    assert.deepEqual(offered, model.resolutions.filter((id) => offered.includes(id)), model.id);
  }
});

test("the ratio picker offers only the shapes H3 renders", () => {
  const ids = VIDEO_RATIOS.map((ratio) => ratio.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ["3:4", "9:16", "4:3", "16:9", "1:1", "adaptive"]);
  assert.equal(videoRatioLabel("adaptive"), "Auto");
});

test("an unknown ratio falls back to 16:9", () => {
  assert.equal(findVideoRatio("9:16").id, "9:16");
  // Shapes the provider does not take must not leak through from a stale client.
  assert.equal(findVideoRatio("21:9").id, "16:9");
  assert.equal(findVideoRatio("4:5").id, "16:9");
  assert.equal(findVideoRatio(undefined).id, "16:9");
  assert.equal(findVideoRatio("nonsense", "1:1").id, "1:1");
});

test("the chosen ratio reaches Router, and Auto becomes 16:9", () => {
  const base = { prompt: "x", mode: "free" as const, duration: 6, resolution: "768P" };
  assert.equal(buildVideoRequest({ ...base, ratio: "9:16" }).ratio, "9:16");
  assert.equal(buildVideoRequest({ ...base, ratio: "3:4" }).ratio, "3:4");

  // Auto is H3's "follow the reference media"; text-only renders need a shape.
  assert.equal(buildVideoRequest({ ...base, ratio: "adaptive" }).ratio, "16:9");
});

test("the trim picker spans the model's range", () => {
  const options = durationOptions(DEFAULT_VIDEO_MODEL);
  assert.equal(options[0], 5);
  assert.equal(options.at(-1), 15);
  assert.equal(options.length, 11);
  assert.ok(options.includes(DEFAULT_VIDEO_MODEL.duration));

  const wide = { ...DEFAULT_VIDEO_MODEL, minDuration: 5, maxDuration: 30 };
  assert.equal(durationOptions(wide).at(-1), 30);
});

test("a stored duration is clamped to the model range", () => {
  assert.equal(clampDuration(12, DEFAULT_VIDEO_MODEL), 12);
  assert.equal(clampDuration(2, DEFAULT_VIDEO_MODEL), 5);
  assert.equal(clampDuration(99, DEFAULT_VIDEO_MODEL), 15);
  assert.equal(clampDuration(7.6, DEFAULT_VIDEO_MODEL), 8);
});

test("the trim window snaps to whole seconds", () => {
  // The exact case that prompted this: a drag landing on 14.1s.
  assert.deepEqual(snapWindow(0, 14.1, 20), { start: 0, end: 14 });
  assert.deepEqual(snapWindow(3.6, 9.4, 20), { start: 4, end: 9 });
  assert.deepEqual(snapWindow(0.4, 6.6, 12), { start: 0, end: 7 });
});

test("the clip editor can snap to tenths of a second", () => {
  assert.deepEqual(snapWindow(1.24, 4.86, 10, 0.5, 15, 0.1), { start: 1.2, end: 4.9 });
  assert.deepEqual(snapWindow(0, 9.97, 10, 0.5, 15, 0.1), { start: 0, end: 10 });
  // A selection shorter than the floor grows to the floor.
  assert.deepEqual(snapWindow(0, 0.3, 10, 0.5, 15, 0.1), { start: 0, end: 0.5 });
});

test("the window stays inside the media and the model limit", () => {
  // A 5.2s clip can only offer five whole seconds.
  assert.deepEqual(snapWindow(0, 9, 5.2), { start: 0, end: 5 });
  // A drag past the end is pulled back to the media's length.
  assert.deepEqual(snapWindow(4, 30, 12), { start: 4, end: 12 });
  // A window wider than the model allows is trimmed from the start.
  assert.deepEqual(snapWindow(0, 12, 30, 1, 6), { start: 6, end: 12 });
  // A tiny window is widened to the minimum.
  assert.deepEqual(snapWindow(3, 3.2, 20), { start: 3, end: 4 });
  // Never negative.
  assert.deepEqual(snapWindow(-5, 4, 10), { start: 0, end: 4 });
});

test("a five second floor widens a short selection", () => {
  // Dragging the end to two seconds is pushed out to five.
  assert.deepEqual(snapWindow(0, 2, 20, 5), { start: 0, end: 5 });
  assert.deepEqual(snapWindow(4, 6, 20, 5), { start: 4, end: 9 });
  // A window that is too short grows forwards to reach the floor.
  assert.deepEqual(snapWindow(8, 10, 20, 5), { start: 8, end: 13 });
  // A media shorter than the floor is used whole rather than overshooting it.
  assert.deepEqual(snapWindow(0, 3, 3.4, 5), { start: 0, end: 3 });
});

test("free mode sends a concrete ratio", () => {
  const body = buildVideoRequest({
    prompt: "A paper boat drifting on a puddle",
    mode: "free",
    ratio: "adaptive",
    duration: 6,
    resolution: "768p",
  });

  assert.deepEqual(body.content, [{ type: "text", text: "A paper boat drifting on a puddle" }]);
  assert.equal(body.ratio, "16:9");
  assert.equal(body.duration, 6);
  assert.equal(body.resolution, "768P");
});

test("audio mode attaches the audio as a reference_audio item", () => {
  const body = buildVideoRequest({
    prompt: "dance",
    mode: "audio",
    ratio: "16:9",
    duration: 5,
    resolution: "768P",
    references: { audio: "data:audio/mpeg;base64,AAAA" },
  });

  const items = body.content as Record<string, unknown>[];
  assert.equal(items.length, 2);
  assert.deepEqual(items[1], {
    type: "audio_url",
    role: "reference_audio",
    audio_url: { url: "data:audio/mpeg;base64,AAAA" },
  });
  assert.equal(body.ratio, "16:9");
});

test("video mode attaches the clip as a reference_video item", () => {
  const body = buildVideoRequest({
    prompt: "same move",
    mode: "video",
    ratio: "16:9",
    duration: 8,
    resolution: "2K",
    references: { video: "data:video/mp4;base64,BBBB" },
  });

  const items = body.content as Record<string, unknown>[];
  assert.equal(items[1]?.type, "video_url");
  assert.equal(items[1]?.role, "reference_video");
  assert.equal(body.resolution, "2K");
});

test("the fal tiers send one flat body, not a content array", () => {
  const body = buildVideoRequest(
    { prompt: "a fox in snow", mode: "free", ratio: "9:16", duration: 5, resolution: "480P" },
    "fal",
  );

  assert.deepEqual(body, {
    prompt: "a fox in snow",
    aspect_ratio: "9:16",
    duration: 5,
    prompt_expansion_mode: "balanced",
    resolution: "480P",
  });

  // fal has no `adaptive`, so Auto has to resolve to a shape.
  const auto = buildVideoRequest({ prompt: "x", mode: "free", ratio: "adaptive", duration: 5, resolution: "768P" }, "fal");
  assert.equal(auto.aspect_ratio, "16:9");

  // `prompt_expansion_mode` is required there; the fuller pass is selectable.
  const quality = buildVideoRequest(
    { prompt: "x", mode: "free", ratio: "16:9", duration: 5, resolution: "2K", expansion: "quality" },
    "fal",
  );
  assert.equal(quality.prompt_expansion_mode, "quality");
  // 2K does not exist on fal, so it clamps to the largest size fal takes.
  assert.equal(quality.resolution, "768P");
});

test("a fal result is read from video.url, not the minimax task document", () => {
  assert.equal(videoResultUrl({ video: { url: "https://example.test/clip.mp4" } }, "fal"), "https://example.test/clip.mp4");
  // The two contracts are not interchangeable.
  assert.equal(
    videoResultUrl({ task: { status: "succeeded", content: { url: "https://example.test/clip.mp4" } } }, "fal"),
    undefined,
  );
  assert.equal(videoResultUrl({ video: { url: "https://example.test/clip.mp4" } }), undefined);
  // A non-https link is not something the route could fetch.
  assert.equal(videoResultUrl({ video: { url: "http://example.test/clip.mp4" } }, "fal"), undefined);
});

test("resolution is normalised to the two values Router accepts", () => {  const base = { prompt: "x", mode: "free" as const, ratio: "16:9", duration: 6, resolution: "768P" };
  assert.equal(buildVideoRequest({ ...base, resolution: "2k" }).resolution, "2K");
  assert.equal(buildVideoRequest({ ...base, resolution: "2K" }).resolution, "2K");
  assert.equal(buildVideoRequest({ ...base, resolution: "768p" }).resolution, "768P");
  assert.equal(buildVideoRequest({ ...base, resolution: "768P" }).resolution, "768P");
  // 480P exists only for the local graph; Router would answer it with a 400.
  assert.equal(buildVideoRequest({ ...base, resolution: "480P" }).resolution, "768P");
  // Anything else lands on the default rather than reaching the provider.
  assert.equal(buildVideoRequest({ ...base, resolution: "4k" }).resolution, "768P");
});

test("character images become reference_image items after the text", () => {
  const body = buildVideoRequest({
    prompt: "a fox walking",
    mode: "free",
    ratio: "16:9",
    duration: 6,
    resolution: "768P",
    references: { images: ["data:image/jpeg;base64,CCCC", "data:image/jpeg;base64,DDDD"] },
  });

  const items = body.content as Record<string, unknown>[];
  assert.equal(items.length, 3);
  assert.equal(items[0]?.type, "text");
  assert.equal(items[1]?.role, "reference_image");
  assert.equal(items[2]?.role, "reference_image");
});

test("mode media is ignored when the mode does not match", () => {
  const body = buildVideoRequest({
    prompt: "x",
    mode: "free",
    ratio: "16:9",
    duration: 6,
    resolution: "768P",
    references: { audio: "data:audio/mpeg;base64,AAAA", video: "data:video/mp4;base64,BBBB" },
  });
  assert.equal((body.content as unknown[]).length, 1);
});

test("duration is clamped to the provider range", () => {
  const short = buildVideoRequest({ prompt: "x", mode: "free", ratio: "16:9", duration: 1, resolution: "768P" });
  const long = buildVideoRequest({ prompt: "x", mode: "free", ratio: "16:9", duration: 90, resolution: "768P" });
  assert.equal(short.duration, 4);
  assert.equal(long.duration, 15);
});

test("reads the clip url out of the task document", () => {
  assert.equal(
    videoResultUrl({ task: { status: "succeeded", content: { url: "https://example.com/clip.mp4" } } }),
    "https://example.com/clip.mp4",
  );
  assert.equal(videoResultUrl({ task: { status: "failed", content: { url: "https://x/y.mp4" } } }), undefined);
  assert.equal(videoResultUrl({ task: { status: "succeeded", content: { url: "http://x/y.mp4" } } }), undefined);
  assert.equal(videoResultUrl({}), undefined);
  assert.equal(videoResultUrl(null), undefined);
});

test("reference modes lock the controls they decide", () => {
  // Free: both pickers stay usable.
  assert.deepEqual(lockedByMode("free"), { duration: false, ratio: false });
  // An audio bed sets its own length; framing is still yours.
  assert.deepEqual(lockedByMode("audio"), { duration: true, ratio: false });
  // A motion reference sets both length and framing.
  assert.deepEqual(lockedByMode("video"), { duration: true, ratio: true });
});

test("surfaces the provider error message", () => {
  assert.equal(
    videoResultError({ task: { status: "failed", error: { code: "x", message: "prompt rejected" } } }),
    "prompt rejected",
  );
  assert.equal(videoResultError({ task: { status: "succeeded" } }), undefined);
});

test("free mode attaches first and last frames as keyframes", () => {
  const body = buildVideoRequest({
    prompt: "a sunrise",
    mode: "free",
    ratio: "16:9",
    duration: 6,
    resolution: "768P",
    references: {
      firstFrame: "data:image/jpeg;base64,AAAA",
      lastFrame: "data:image/jpeg;base64,BBBB",
    },
  });

  const items = body.content as Record<string, unknown>[];
  assert.equal(items.length, 3);
  assert.deepEqual(items[1], {
    type: "image_url",
    role: "first_frame",
    image_url: { url: "data:image/jpeg;base64,AAAA" },
  });
  assert.deepEqual(items[2], {
    type: "image_url",
    role: "last_frame",
    image_url: { url: "data:image/jpeg;base64,BBBB" },
  });
});

test("keyframes replace reference images, which cannot share a request", () => {
  const body = buildVideoRequest({
    prompt: "x",
    mode: "free",
    ratio: "16:9",
    duration: 6,
    resolution: "768P",
    references: {
      firstFrame: "data:image/jpeg;base64,AAAA",
      images: ["data:image/jpeg;base64,CCCC"],
    },
  });

  const roles = (body.content as Record<string, unknown>[]).map((item) => item.role);
  assert.deepEqual(roles, [undefined, "first_frame"]);
  assert.ok(!roles.includes("reference_image"));
});

test("keyframes are ignored outside free mode", () => {
  const body = buildVideoRequest({
    prompt: "x",
    mode: "audio",
    ratio: "16:9",
    duration: 6,
    resolution: "768P",
    references: { audio: "data:audio/mpeg;base64,AAAA", firstFrame: "data:image/jpeg;base64,BBBB" },
  });
  const roles = (body.content as Record<string, unknown>[]).map((item) => item.role);
  assert.deepEqual(roles, [undefined, "reference_audio"]);
});

test("detects keyframe runs", () => {
  assert.equal(usesKeyframes({ firstFrame: "x" }), true);
  assert.equal(usesKeyframes({ lastFrame: "x" }), true);
  assert.equal(usesKeyframes({ images: ["x"] }), false);
  assert.equal(usesKeyframes(undefined), false);
});

test("parses a rewritten shot from the video brain", () => {
  assert.equal(parseVideoPrompt('{"prompt":"Slow dolly through neon rain."}'), "Slow dolly through neon rain.");
  assert.equal(parseVideoPrompt('```json\n{"prompt":"A dolly in."}\n```'), "A dolly in.");
  assert.equal(parseVideoPrompt('{"intent":"answer","answer":"no"}'), undefined);
  assert.equal(parseVideoPrompt("not json"), undefined);
  assert.equal(parseVideoPrompt('{"prompt":"   "}'), undefined);
});

test("multiple characters use the plural clause", () => {
  const two = composePrompt("A scene.", "", { characters: 2 });
  assert.ok(two.includes(CHARACTERS_CLAUSE));
  const one = composePrompt("A scene.", "", { characters: 1 });
  assert.ok(one.includes(CHARACTER_CLAUSE));
  assert.ok(!one.includes(CHARACTERS_CLAUSE));
});

test("a frame's caption is not mistaken for a typed prompt", () => {
  // The panel labels a reference render it had no words for; that label was
  // once saved in `sourcePrompt`, so a reuse has to recognise and drop it.
  assert.equal(isReferenceCaption("Video Reference reference"), true);
  assert.equal(isReferenceCaption("Audio Reference reference"), true);
  assert.equal(isReferenceCaption("  Video Reference reference  "), true);
  assert.equal(isReferenceCaption("Free reference"), false);
  assert.equal(isReferenceCaption("Riding a bike"), false);
  assert.equal(isReferenceCaption(""), false);
});
