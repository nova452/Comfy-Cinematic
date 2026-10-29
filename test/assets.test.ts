import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_UPLOADS,
  RECENT_LIMIT,
  SAMPLE_CLIPS,
  acceptFor,
  addUpload,
  assetKindFrom,
  fitsKind,
  libraryFilters,
  pickAssets,
  pickLibrary,
  renderAsset,
  toggleLiked,
  uploadType,
  type Asset,
  type AssetKind,
  type AssetOrigin,
} from "../lib/assets.ts";

function asset(id: string, kind: AssetKind, createdAt: number, origin: AssetOrigin = "upload"): Asset {
  return { id, kind, origin, name: id, src: `/api/renders/${id}.png`, createdAt };
}

test("files are classified by mime first, then by extension", () => {
  assert.equal(assetKindFrom({ type: "image/png", name: "photo" }), "image");
  assert.equal(assetKindFrom({ type: "audio/mpeg", name: "track" }), "audio");
  assert.equal(assetKindFrom({ type: "video/mp4", name: "clip" }), "video");

  // Browsers can leave the type empty, and people rename files.
  assert.equal(assetKindFrom({ type: "", name: "take.MP3" }), "audio");
  assert.equal(assetKindFrom({ name: "shot.webm" }), "video");
  assert.equal(assetKindFrom({ type: "application/pdf", name: "script.webp" }), "image");

  assert.equal(assetKindFrom({ name: "notes.txt" }), undefined);
  assert.equal(assetKindFrom({}), undefined);
});

test("each slot offers the file types it can actually take", () => {
  assert.equal(acceptFor("image"), "image/png,image/jpeg,image/webp");
  assert.equal(acceptFor("audio"), "audio/mpeg,audio/wav,audio/mp4");
  assert.equal(acceptFor("video"), "video/mp4,video/webm");
});

test("uploads are gated to the kinds the slot and the API accept", () => {
  assert.equal(fitsKind({ type: "image/png" }, "image"), true);
  assert.equal(fitsKind({ type: "image/gif" }, "image"), false);
  assert.equal(fitsKind({ type: "image/png" }, "video"), false);

  assert.equal(fitsKind({ type: "video/webm" }, "video"), true);
  assert.equal(fitsKind({ type: "video/quicktime" }, "video"), false);

  assert.equal(fitsKind({ type: "audio/mpeg" }, "audio"), true);
  assert.equal(fitsKind({ type: "audio/x-wav" }, "audio"), true);

  // Drag and drop can hand over an empty or generic type; the name decides.
  assert.equal(fitsKind({ type: "", name: "shot.MP4" }, "video"), true);
  assert.equal(fitsKind({ type: "application/octet-stream", name: "take.m4a" }, "audio"), true);
  assert.equal(fitsKind({ name: "notes.txt" }, "image"), false);
});

test("a frame becomes a named, pickable render", () => {
  const still = renderAsset(
    { id: "a", src: "/api/renders/a.png", prompt: "a lighthouse", sourcePrompt: "a lighthouse", createdAt: 10 },
    0,
  );
  assert.equal(still.id, "render:a");
  assert.equal(still.kind, "image");
  assert.equal(still.origin, "render");
  assert.equal(still.name, "Still 01");
  assert.equal(still.note, "a lighthouse");
  assert.equal(still.detail, undefined);
  assert.equal(still.seconds, undefined);

  const clip = renderAsset({ id: "b", src: "/api/renders/b.mp4", seconds: 6, createdAt: 20 }, 3);
  assert.equal(clip.kind, "video");
  assert.equal(clip.name, "Clip 04");
  assert.equal(clip.seconds, 6);

  // The stored `media` field wins over a stale extension.
  assert.equal(renderAsset({ id: "c", src: "/api/renders/c.png", media: "video", createdAt: 0 }, 0).kind, "video");
});

test("the typed prompt is the headline and the rewrite is folded", () => {
  const enhanced = renderAsset(
    {
      id: "d",
      src: "/api/renders/d.png",
      prompt: "An athlete running. cinematic film still, anamorphic, subtle grain.",
      sourcePrompt: "  an athlete running  ",
      createdAt: 1,
    },
    0,
  );
  assert.equal(enhanced.note, "an athlete running");
  assert.equal(enhanced.detail, "An athlete running. cinematic film still, anamorphic, subtle grain.");

  // A prompt the provider only tidied is not worth folding away.
  const tidied = renderAsset(
    { id: "f", src: "/api/renders/f.png", prompt: "A lone pigeon.", sourcePrompt: "a lone pigeon", createdAt: 3 },
    0,
  );
  assert.equal(tidied.note, "a lone pigeon");
  assert.equal(tidied.detail, undefined);

  // Nothing typed but a brief was sent: the tile is named, the brief folded.
  const brief = renderAsset(
    { id: "e", src: "/api/renders/e.mp4", prompt: "subject_definitions: …", sourcePrompt: "", createdAt: 2 },
    0,
  );
  assert.equal(brief.note, undefined);
  assert.equal(brief.detail, "subject_definitions: …");
});

test("the grid only shows assets the slot can take", () => {
  const library = {
    uploads: [asset("u-img", "image", 10), asset("u-clip", "video", 20), asset("u-aud", "audio", 30)],
    renders: [asset("r-img", "image", 40, "render"), asset("r-clip", "video", 50, "render")],
    liked: ["u-img", "r-clip"],
  };

  assert.deepEqual(
    pickAssets(library, "image", "uploads", "all").map((item) => item.id),
    ["u-img"],
  );
  assert.deepEqual(
    pickAssets(library, "video", "generations", "all").map((item) => item.id),
    ["r-clip"],
  );
  // There are no audio renders, so an audio slot has nothing under Output.
  assert.deepEqual(pickAssets(library, "audio", "generations", "all"), []);
  assert.deepEqual(
    pickAssets(library, "image", "liked", "all").map((item) => item.id),
    ["u-img"],
  );
  assert.deepEqual(
    pickAssets(library, "video", "liked", "all").map((item) => item.id),
    ["r-clip"],
  );
});

test("recent is the newest slice; all is everything, newest first", () => {
  const renders = Array.from({ length: RECENT_LIMIT + 4 }, (_, index) =>
    asset(`r-${String(index).padStart(2, "0")}`, "image", index + 1, "render"),
  );
  const library = { uploads: [], renders, liked: [] };

  const recent = pickAssets(library, "image", "generations", "recent");
  assert.equal(recent.length, RECENT_LIMIT);
  assert.equal(recent[0]!.id, `r-${String(renders.length - 1).padStart(2, "0")}`);

  const all = pickAssets(library, "image", "generations", "all");
  assert.equal(all.length, renders.length);
  assert.equal(all.at(-1)!.id, "r-00");
});

test("the library tab is one flat list, newest first, or one kind", () => {
  const library = {
    uploads: [asset("u-img", "image", 10), asset("u-clip", "video", 20), asset("u-aud", "audio", 30)],
    renders: [asset("r-img", "image", 40, "render"), asset("r-clip", "video", 50, "render")],
    liked: ["u-img", "r-clip"],
  };

  // Recent is everything, mixed, newest first — not grouped by kind.
  assert.deepEqual(
    pickLibrary(library, "uploads", "recent").map((item) => item.id),
    ["u-aud", "u-clip", "u-img"],
  );
  assert.deepEqual(
    pickLibrary(library, "generations", "recent").map((item) => item.id),
    ["r-clip", "r-img"],
  );

  assert.deepEqual(
    pickLibrary(library, "uploads", "image").map((item) => item.id),
    ["u-img"],
  );
  assert.deepEqual(
    pickLibrary(library, "uploads", "video").map((item) => item.id),
    ["u-clip"],
  );
  assert.deepEqual(
    pickLibrary(library, "uploads", "audio").map((item) => item.id),
    ["u-aud"],
  );
  // Audio is never rendered, so that pill is empty under Output.
  assert.deepEqual(pickLibrary(library, "generations", "audio"), []);

  // Saved still narrows to the starred ids, whatever the filter.
  assert.deepEqual(
    pickLibrary(library, "liked", "recent").map((item) => item.id),
    ["r-clip", "u-img"],
  );
  assert.deepEqual(
    pickLibrary(library, "liked", "image").map((item) => item.id),
    ["u-img"],
  );
});

test("output has no audio filter, because nothing renders audio", () => {
  assert.deepEqual(
    libraryFilters("uploads").map((item) => item.id),
    ["recent", "image", "video", "audio"],
  );
  assert.deepEqual(
    libraryFilters("liked").map((item) => item.id),
    ["recent", "image", "video", "audio"],
  );
  assert.deepEqual(
    libraryFilters("generations").map((item) => item.id),
    ["recent", "image", "video"],
  );
});

test("the library keeps older assets that a picker would cut off", () => {
  const renders = Array.from({ length: RECENT_LIMIT + 4 }, (_, index) =>
    asset(`r-${String(index).padStart(2, "0")}`, "image", index + 1, "render"),
  );
  const library = { uploads: [], renders, liked: [] };

  assert.equal(pickAssets(library, "image", "generations", "recent").length, RECENT_LIMIT);
  assert.equal(pickLibrary(library, "generations", "recent").length, renders.length);
  assert.equal(pickLibrary(library, "generations", "image").length, renders.length);
});

test("re-uploading moves an asset to the front and the list is capped", () => {
  const list = [asset("a", "image", 1), asset("b", "image", 2)];
  assert.deepEqual(addUpload(list, asset("b", "image", 3)).map((item) => item.id), ["b", "a"]);

  const full = Array.from({ length: MAX_UPLOADS + 3 }, (_, index) => asset(`u${index}`, "image", index));
  const capped = addUpload(full, asset("new", "image", 99));
  assert.equal(capped.length, MAX_UPLOADS);
  assert.equal(capped[0]!.id, "new");
});

test("the upload store labels a file from its mime, then its name", () => {
  assert.equal(uploadType({ type: "image/png", name: "shot.png" }), "image/png");
  assert.equal(uploadType({ type: "video/webm;codecs=vp9", name: "clip.webm" }), "video/webm");
  // Empty or generic types are common; the name is the fallback.
  assert.equal(uploadType({ type: "", name: "take.M4A" }), "audio/mp4");
  assert.equal(uploadType({ type: "application/octet-stream", name: "clip.webm" }), "video/webm");
  assert.equal(uploadType({ name: "notes.txt" }), undefined);
});

test("liked ids toggle on and off", () => {
  assert.deepEqual(toggleLiked([], "render:a"), ["render:a"]);
  assert.deepEqual(toggleLiked(["render:a", "upload:b"], "render:a"), ["upload:b"]);
  assert.deepEqual(toggleLiked(["render:a"], "upload:b"), ["upload:b", "render:a"]);
});

test("the hosted samples are video clips the Samples tab offers", () => {
  assert.ok(SAMPLE_CLIPS.length > 0);
  const srcs = new Set<string>();
  for (const sample of SAMPLE_CLIPS) {
    assert.equal(sample.kind, "video");
    assert.equal(sample.origin, "sample");
    assert.match(sample.src, /\/samples\/sample-\d+\.mp4$/);
    srcs.add(sample.src);
  }
  assert.equal(srcs.size, SAMPLE_CLIPS.length);

  const library = { uploads: [], renders: [], liked: [] };
  assert.deepEqual(pickAssets(library, "video", "samples", "recent"), [...SAMPLE_CLIPS]);
  // A still slot never offers clips, and samples never leak into other tabs.
  assert.deepEqual(pickAssets(library, "image", "samples", "recent"), []);
  assert.deepEqual(pickAssets(library, "video", "uploads", "recent"), []);
});
