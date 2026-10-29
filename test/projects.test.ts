import assert from "node:assert/strict";
import test from "node:test";
import {
  FRAME_SIZE,
  MAX_FRAME_PROMPT,
  MAX_FRAMES,
  clipSeconds,
  createProject,
  frameBounds,
  isVideoSrc,
  nextPosition,
  normalizeName,
  normalizeProject,
  relativeTime,
  stylePhrase,
  summarize,
  type Frame,
} from "../lib/projects.ts";

const SRC = "/api/renders/11111111-2222-3333-4444-555555555555.png";

function frame(overrides: Partial<Frame> = {}): Frame {
  return {
    id: crypto.randomUUID(),
    src: SRC,
    prompt: "a fox",
    style: "none",
    model: "bfl/flux-3-image",
    x: 0,
    y: 0,
    createdAt: 1,
    ...overrides,
  };
}

test("new projects start empty and named", () => {
  const project = createProject("  My   film  ", 1000);
  assert.equal(project.name, "My film");
  assert.deepEqual(project.frames, []);
  assert.deepEqual(project.messages, []);
  assert.equal(project.createdAt, 1000);
  assert.match(project.id, /^[a-f0-9-]{36}$/);
});

test("names fall back and are capped", () => {
  assert.equal(normalizeName("   "), "Untitled project");
  assert.equal(normalizeName("a".repeat(200)).length, 80);
});

test("frames fill a three-column grid", () => {
  const positions = Array.from({ length: 4 }, (_, index) => nextPosition([frame({ x: 1e9, y: index })] as Frame[]));
  assert.equal(positions.length, 4);

  assert.deepEqual(nextPosition([]), { x: 0, y: 0 });
  const one = [frame({ x: 0, y: 0 })];
  assert.deepEqual(nextPosition(one), { x: FRAME_SIZE + 32, y: 0 });
  const two = [...one, frame({ x: FRAME_SIZE + 32, y: 0 })];
  assert.deepEqual(nextPosition(two), { x: (FRAME_SIZE + 32) * 2, y: 0 });
  const three = [...two, frame({ x: (FRAME_SIZE + 32) * 2, y: 0 })];
  assert.deepEqual(nextPosition(three), { x: 0, y: FRAME_SIZE + 32 });
});

test("nextPosition skips a slot a dragged frame already occupies", () => {
  const step = FRAME_SIZE + 32;
  // Dropped exactly on slot 1.
  assert.deepEqual(nextPosition([frame({ x: step, y: 0 })]), { x: 0, y: 0 });

  // Nudged a little, still only covering slot 0.
  assert.deepEqual(nextPosition([frame({ x: 18, y: 14 })]), { x: step, y: 0 });

  // Straddling two cells covers both, so the next render starts at slot 2.
  assert.deepEqual(nextPosition([frame({ x: 300, y: 30 })]), { x: step * 2, y: 0 });

  // A slot reserved by a render in flight counts exactly like a frame.
  assert.deepEqual(nextPosition([{ x: 0, y: 0 }]), { x: step, y: 0 });
});

test("bounds cover every frame", () => {
  const bounds = frameBounds([
    frame({ x: 0, y: 0 }),
    frame({ x: 1000, y: 600 }),
  ]);
  assert.deepEqual(bounds, { x: 0, y: 0, width: 1000 + FRAME_SIZE, height: 600 + FRAME_SIZE });
  assert.deepEqual(frameBounds([]), { x: 0, y: 0, width: FRAME_SIZE, height: FRAME_SIZE });
});

test("only local render paths are accepted as frame sources", () => {
  const ok = normalizeProject({ id: crypto.randomUUID(), frames: [frame()] });
  assert.equal(ok?.frames.length, 1);

  const remote = normalizeProject({
    id: crypto.randomUUID(),
    frames: [{ ...frame(), src: "https://evil.example/x.png" }],
  });
  assert.equal(remote?.frames.length, 0);

  const traversal = normalizeProject({
    id: crypto.randomUUID(),
    frames: [{ ...frame(), src: "/api/renders/../../secret.png" }],
  });
  assert.equal(traversal?.frames.length, 0);
});

test("keeps the typed prompt and reference images on a frame", () => {
  const project = normalizeProject({
    id: crypto.randomUUID(),
    frames: [
      frame({
        prompt: "Enhanced, long prompt.",
        sourcePrompt: "a fox",
        enhanced: true,
        characterSrcs: [SRC, SRC],
        backgroundSrc: SRC,
      }),
    ],
  });

  const saved = project?.frames[0];
  assert.equal(saved?.sourcePrompt, "a fox");
  assert.equal(saved?.enhanced, true);
  assert.deepEqual(saved?.characterSrcs, [SRC, SRC]);
  assert.equal(saved?.backgroundSrc, SRC);
});

test("keeps a single reference image on a still", () => {
  const project = normalizeProject({
    id: crypto.randomUUID(),
    frames: [frame({ referenceSrc: SRC })],
  });
  assert.equal(project?.frames[0]?.referenceSrc, SRC);
  assert.deepEqual(project?.frames[0]?.referenceSrcs, [SRC]);

  // Only a stored render path is a reference; a remote URL is dropped.
  const bad = normalizeProject({
    id: crypto.randomUUID(),
    frames: [{ ...frame(), referenceSrc: "https://example.com/a.png" }],
  });
  assert.equal(bad?.frames[0]?.referenceSrc, undefined);
});

test("keeps the first four reference images in order", () => {
  const project = normalizeProject({
    id: crypto.randomUUID(),
    frames: [frame({ referenceSrcs: [SRC, SRC, SRC, SRC, SRC] })],
  });
  assert.deepEqual(project?.frames[0]?.referenceSrcs, [SRC, SRC, SRC, SRC]);
});

test("keeps a canvas image and the edit flag", () => {
  const project = normalizeProject({
    id: crypto.randomUUID(),
    frames: [
      frame({
        canvasSrc: SRC,
        recipe: { tab: "create", canvas: true },
      }),
    ],
  });

  assert.equal(project?.frames[0]?.canvasSrc, SRC);
  assert.equal(project?.frames[0]?.recipe?.canvas, true);
});

test("lifts the legacy single character field into the list", () => {
  const project = normalizeProject({
    id: crypto.randomUUID(),
    frames: [{ ...frame(), characterSrc: SRC }],
  });
  assert.deepEqual(project?.frames[0]?.characterSrcs, [SRC]);
});

test("keeps the recipe a frame was made with", () => {
  const project = normalizeProject({
    id: crypto.randomUUID(),
    frames: [
      frame({
        media: "video",
        recipe: {
          tab: "video",
          flavor: null,
          ratio: "9:16",
          resolution: "768P",
          video: { model: "minimax/minimax-h3", mode: "video", ratio: "9:16", resolution: "768P", duration: 8 },
        },
      }),
    ],
  });

  const recipe = project?.frames[0]?.recipe;
  assert.equal(recipe?.tab, "video");
  assert.equal(recipe?.flavor, null);
  assert.deepEqual(recipe?.video, {
    model: "minimax/minimax-h3",
    mode: "video",
    ratio: "9:16",
    resolution: "768P",
    duration: 8,
  });
});

test("keeps an image recipe's shape, size and batch", () => {
  const project = normalizeProject({
    id: crypto.randomUUID(),
    frames: [
      frame({
        recipe: {
          tab: "create",
          image: "local/flux-3-image",
          ratio: "16:9",
          resolution: "2k",
          batch: 4,
        },
      }),
    ],
  });

  assert.deepEqual(project?.frames[0]?.recipe, {
    tab: "create",
    image: "local/flux-3-image",
    ratio: "16:9",
    resolution: "2k",
    batch: 4,
  });

  const clamped = normalizeProject({
    id: crypto.randomUUID(),
    frames: [frame({ recipe: { tab: "create", batch: 99 } })],
  });
  assert.equal(clamped?.frames[0]?.recipe?.batch, 4);
});

test("a recipe is re-validated, never trusted", () => {
  const project = normalizeProject({
    id: crypto.randomUUID(),
    frames: [
      frame({
        recipe: {
          tab: "bogus",
          video: { model: 42, mode: "sideways", duration: "long" },
        } as never,
      }),
    ],
  });
  // A tab it cannot name means there is nothing to replay.
  assert.equal(project?.frames[0]?.recipe, undefined);

  const mixed = normalizeProject({
    id: crypto.randomUUID(),
    frames: [
      frame({
        recipe: {
          tab: "video",
          ratio: "16:9",
          video: { model: "fal/h3-max", mode: "sideways", duration: 900 },
        } as never,
      }),
    ],
  });
  const recipe = mixed?.frames[0]?.recipe;
  assert.equal(recipe?.video?.mode, "free");
  assert.equal(recipe?.video?.duration, 60);
  // A mode it cannot name still leaves the tab, which is what Reuse needs.
  assert.equal(recipe?.tab, "video");
});

test("a frame prompt may hold a whole six-section rewrite", () => {
  const long = "x".repeat(3000);
  const project = normalizeProject({
    id: crypto.randomUUID(),
    frames: [{ ...frame(), prompt: long }],
  });
  assert.equal(project?.frames[0]?.prompt.length, 3000);

  const huge = "y".repeat(9000);
  const capped = normalizeProject({
    id: crypto.randomUUID(),
    frames: [{ ...frame(), prompt: huge }],
  });
  assert.equal(capped?.frames[0]?.prompt.length, MAX_FRAME_PROMPT);
});

test("caps character references at three", () => {
  const project = normalizeProject({
    id: crypto.randomUUID(),
    frames: [frame({ characterSrcs: [SRC, SRC, SRC, SRC, SRC] })],
  });
  assert.equal(project?.frames[0]?.characterSrcs?.length, 3);
});

test("recognises a clip frame", () => {
  const clip = "/api/renders/11111111-2222-3333-4444-555555555555.mp4";
  const project = normalizeProject({ id: crypto.randomUUID(), frames: [frame({ src: clip, seconds: 9 })] });
  assert.equal(project?.frames[0]?.src, clip);
  assert.equal(project?.frames[0]?.media, "video");
  assert.equal(project?.frames[0]?.seconds, 9);
  assert.equal(isVideoSrc(clip), true);
  assert.equal(isVideoSrc(SRC), false);

  const webm = "/api/renders/11111111-2222-3333-4444-555555555555.webm";
  assert.equal(isVideoSrc(webm), true);
});

test("only clips carry a length, and it stays whole seconds", () => {
  const still = normalizeProject({ id: crypto.randomUUID(), frames: [frame({ seconds: 7 })] });
  assert.equal(still?.frames[0]?.seconds, undefined);

  const clip = "/api/renders/11111111-2222-3333-4444-555555555555.mp4";
  const rounded = normalizeProject({ id: crypto.randomUUID(), frames: [frame({ src: clip, seconds: 8.7 })] });
  assert.equal(rounded?.frames[0]?.seconds, 9);

  const clamped = normalizeProject({ id: crypto.randomUUID(), frames: [frame({ src: clip, seconds: 999 })] });
  assert.equal(clamped?.frames[0]?.seconds, 60);
});

test("clip runtime sums only clip lengths", () => {
  const clip = "/api/renders/11111111-2222-3333-4444-555555555555.mp4";
  const frames = [frame({ seconds: 999 }), frame({ src: clip, seconds: 6 }), frame({ src: clip, seconds: 9 })];
  assert.equal(clipSeconds(frames), 15);
  assert.equal(clipSeconds([]), 0);
});

test("the library travels with the project", () => {
  const SONG = "/api/renders/33333333-3333-3333-3333-333333333333.mp3";
  const project = normalizeProject({
    id: crypto.randomUUID(),
    assets: [
      { id: "upload:11111111-1111-1111-1111-111111111111", name: "  my  photo.png ", src: SRC, createdAt: 10 },
      { id: "upload:22222222-2222-2222-2222-222222222222", name: "voice.mp3", src: SONG, createdAt: 20, seconds: 12.4 },
      // Remote and traversal paths never become assets.
      { id: "upload:33333333-3333-3333-3333-333333333333", name: "x.png", src: "https://evil.example/x.png", createdAt: 30 },
      { id: "upload:44444444-4444-4444-4444-444444444444", name: "x.png", src: "/api/renders/../../x.png", createdAt: 40 },
    ],
    saved: ["render:55555555-5555-5555-5555-555555555555", "nonsense", 7, "upload:11111111-1111-1111-1111-111111111111"],
  });

  assert.deepEqual(
    project?.assets.map((asset) => asset.src),
    [SONG, SRC],
  );
  assert.deepEqual(
    project?.assets.map((asset) => asset.kind),
    ["audio", "image"],
  );
  assert.equal(project?.assets[1]?.name, "my photo.png");
  // A length belongs to tracks and clips, not stills.
  assert.equal(project?.assets[0]?.seconds, 12);
  assert.equal(project?.assets[1]?.seconds, undefined);
  assert.deepEqual(project?.saved, [
    "render:55555555-5555-5555-5555-555555555555",
    "upload:11111111-1111-1111-1111-111111111111",
  ]);
});

test("a track can be an asset but never a frame", () => {
  const song = "/api/renders/33333333-3333-3333-3333-333333333333.mp3";
  const project = normalizeProject({ id: crypto.randomUUID(), frames: [frame({ src: song })] });
  assert.equal(project?.frames.length, 0);
});

test("drops a reference that is not a local render", () => {
  const project = normalizeProject({
    id: crypto.randomUUID(),
    frames: [frame({ characterSrcs: ["https://example.com/face.png"], backgroundSrc: "nope" })],
  });
  assert.deepEqual(project?.frames[0]?.characterSrcs, []);
  assert.equal(project?.frames[0]?.backgroundSrc, undefined);
});

test("rejects documents without a valid id", () => {
  assert.equal(normalizeProject({ name: "x" }), undefined);
  assert.equal(normalizeProject({ id: "../../etc/passwd" }), undefined);
  assert.equal(normalizeProject(null), undefined);
  assert.equal(normalizeProject("nope"), undefined);
});

test("drops malformed messages and frames instead of failing", () => {
  const project = normalizeProject({
    id: crypto.randomUUID(),
    name: "  ",
    frames: [frame(), { src: "nope" }, null],
    messages: [
      { role: "user", text: "hi" },
      { role: "system", text: "nope" },
      { role: "assistant", text: "   " },
    ],
  });

  assert.equal(project?.name, "Untitled project");
  assert.equal(project?.frames.length, 1);
  assert.equal(project?.messages.length, 1);
  assert.equal(project?.messages[0]?.role, "user");
});

test("caps frames and messages", () => {
  const project = normalizeProject({
    id: crypto.randomUUID(),
    frames: Array.from({ length: MAX_FRAMES + 20 }, () => frame()),
    messages: Array.from({ length: 300 }, () => ({ role: "user", text: "hi" })),
  });
  assert.equal(project?.frames.length, MAX_FRAMES);
  assert.equal(project?.messages.length, 200);
});

test("summaries expose the first frame as the preview", () => {
  const project = { ...createProject("Reel", 5), frames: [frame(), frame({ x: 600 })] };
  const summary = summarize(project);
  assert.equal(summary.count, 2);
  assert.equal(summary.preview, SRC);
  assert.equal(summary.name, "Reel");
});

test("styles map to prompt phrases", () => {
  assert.equal(stylePhrase("none"), "");
  assert.match(stylePhrase("cinematic"), /cinematic/);
  assert.equal(stylePhrase("nonsense"), "");
});

test("relative times read naturally", () => {
  const now = Date.UTC(2026, 0, 2, 12, 0, 0);
  assert.equal(relativeTime(now - 30_000, now), "just now");
  assert.equal(relativeTime(now - 5 * 60_000, now), "5m ago");
  assert.equal(relativeTime(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(relativeTime(now - 2 * 86_400_000, now), "2d ago");
});
