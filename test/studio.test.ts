import assert from "node:assert/strict";
import test from "node:test";
import {
  STUDIO_SYSTEM_PROMPT,
  describePlan,
  describeStudioState,
  parseStudioAction,
  planFromPrompt,
  planFromRaw,
} from "../lib/studio.ts";

test("the chat prompt knows the app and forbids rendering", () => {
  assert.ok(STUDIO_SYSTEM_PROMPT.includes("Create tab"));
  assert.ok(STUDIO_SYSTEM_PROMPT.includes("Video tab"));
  assert.ok(STUDIO_SYSTEM_PROMPT.includes("Never render"));
  assert.ok(STUDIO_SYSTEM_PROMPT.includes("bfl/flux-3-image"));
  // The ids are read from the same tables the pickers use, so they cannot drift.
  assert.ok(STUDIO_SYSTEM_PROMPT.includes("21:9"));
  assert.ok(STUDIO_SYSTEM_PROMPT.includes("minimax/minimax-h3"));
  assert.equal(/—/.test(STUDIO_SYSTEM_PROMPT), false);
});

test("parses an answer", () => {
  assert.deepEqual(parseStudioAction('{"action":"answer","answer":"Blue light scatters."}'), {
    action: "answer",
    answer: "Blue light scatters.",
  });
  // The older shape still works, so a model that ignores the new schema is fine.
  assert.deepEqual(parseStudioAction('{"intent":"answer","answer":"Yes."}'), {
    action: "answer",
    answer: "Yes.",
  });
});

test("parses a create plan with every control set", () => {
  const action = parseStudioAction(
    JSON.stringify({
      action: "open",
      tab: "create",
      prompt: "A red fox in snow",
      image: "bfl/flux-3-image",
      edit: false,
      ratio: "16:9",
      resolution: "2k",
      batch: 3,
    }),
  );

  assert.deepEqual(action, {
    action: "open",
    plan: {
      tab: "create",
      prompt: "A red fox in snow",
      image: "bfl/flux-3-image",
      edit: false,
      ratio: "16:9",
      resolution: "2k",
      batch: 3,
    },
  });
});

test("clamps a create plan into values the tool accepts", () => {
  const action = parseStudioAction(
    JSON.stringify({
      action: "open",
      tab: "create",
      ratio: "banana",
      resolution: "huge",
      batch: 99,
      image: "nope/nothing",
    }),
  );
  assert.equal(action?.action, "open");
  if (action?.action !== "open") return;

  // An unknown tool is dropped rather than selected.
  assert.equal(action.plan.image, undefined);
  assert.equal(action.plan.ratio, "1:1");
  assert.equal(action.plan.resolution, "1k");
  assert.equal(action.plan.batch, 4);
});

test("a plan keeps only the fields it was given", () => {
  const action = parseStudioAction('{"action":"open","tab":"create","prompt":"A lighthouse"}');
  assert.deepEqual(action, { action: "open", plan: { tab: "create", prompt: "A lighthouse" } });
});

test("infers the tab when the model forgets it", () => {
  assert.deepEqual(planFromRaw({ prompt: "a fox" }), { tab: "create", prompt: "a fox" });
  assert.deepEqual(planFromRaw({ mode: "free" }), { tab: "video", mode: "free" });
  assert.equal(planFromRaw({}), undefined);
  assert.equal(planFromRaw({ tab: "settings" }), undefined);
});

test("parses a video plan, normalizing the mode label", () => {
  const action = parseStudioAction(
    JSON.stringify({
      action: "open",
      tab: "video",
      prompt: "A slow dolly past neon signs",
      video: "fal/h3-max",
      mode: "Audio Reference",
      resolution: "480P",
      seconds: 99,
    }),
  );

  assert.equal(action?.action, "open");
  if (action?.action !== "open") return;
  assert.equal(action.plan.video, "fal/h3-max");
  // fal/h3-max is prompt-only, so a reference mode it does not offer is dropped.
  assert.equal(action.plan.mode, undefined);
  assert.equal(action.plan.resolution, "480P");
  assert.equal(action.plan.seconds, 15);
});

test("a reference mode drops the length it owns", () => {
  const action = parseStudioAction(
    JSON.stringify({ action: "open", tab: "video", mode: "video", ratio: "9:16", seconds: 9 }),
  );
  assert.equal(action?.action, "open");
  if (action?.action !== "open") return;
  // A video reference decides both the shape and the length.
  assert.equal(action.plan.ratio, undefined);
  assert.equal(action.plan.seconds, undefined);
});

test("Edit on locks the shape to the canvas image", () => {
  const action = parseStudioAction(
    JSON.stringify({ action: "open", tab: "create", edit: true, ratio: "16:9" }),
  );
  assert.equal(action?.action, "open");
  if (action?.action !== "open") return;
  assert.equal(action.plan.edit, true);
  assert.equal(action.plan.ratio, undefined);
  assert.ok(describePlan(action.plan).includes("Add the image you want edited first"));
});

test("rejects replies with no usable action", () => {
  assert.equal(parseStudioAction("no json here"), undefined);
  assert.equal(parseStudioAction("{not json}"), undefined);
  assert.equal(parseStudioAction('{"action":"render","tab":"create"}'), undefined);
  assert.equal(parseStudioAction('{"action":"answer","answer":"  "}'), undefined);
});

test("accepts a fenced or chatty reply", () => {
  const fenced = '```json\n{"action":"open","tab":"assets"}\n```';
  assert.deepEqual(parseStudioAction(fenced), { action: "open", plan: { tab: "assets" } });

  const chatty = 'Sure. {"action":"answer","answer":"Yes."} Hope that helps.';
  assert.deepEqual(parseStudioAction(chatty), { action: "answer", answer: "Yes." });
});

test("the offline plan fills the Create prompt and nothing else", () => {
  const plan = planFromPrompt("  a  fox   in snow  ");
  assert.deepEqual(plan, { tab: "create", prompt: "a fox in snow" });
  assert.equal(planFromPrompt(" "), undefined);
});

test("caps a prompt the model overshoots", () => {
  const action = parseStudioAction(
    JSON.stringify({ action: "open", tab: "create", prompt: "x".repeat(1200) }),
  );
  assert.equal(action?.action, "open");
  if (action?.action !== "open") return;
  assert.equal(action.plan.prompt?.length, 900);
});

test("the confirmation says what was set, and that nothing rendered", () => {
  const create = describePlan({
    tab: "create",
    prompt: "A red fox",
    ratio: "16:9",
    resolution: "2k",
    batch: 2,
  });
  assert.ok(create.includes("Opened Create"));
  assert.ok(create.includes("16:9"));
  assert.ok(create.includes("2K"));
  assert.ok(create.includes("x2"));
  assert.ok(create.includes("A red fox"));
  assert.ok(create.includes("Nothing was generated"));

  const video = describePlan({ tab: "video", mode: "audio", prompt: "A drone shot" });
  assert.ok(video.includes("Audio Reference"));
  assert.ok(video.includes("needs a reference file"));
  assert.ok(video.includes("Nothing was generated"));

  const assets = describePlan({ tab: "assets" });
  assert.ok(assets.includes("Opened Assets"));
  assert.ok(assets.includes("Nothing was generated"));
});

test("the panel state gives the brain something to resolve against", () => {
  const line = describeStudioState({
    tab: "chat",
    create: {
      prompt: "a fox",
      image: "bfl/flux-3-image",
      edit: true,
      ratio: "9:16",
      resolution: "4k",
      batch: 2,
    },
    video: { prompt: "a drone shot", video: "minimax/minimax-h3", mode: "free", ratio: "16:9", seconds: 9 },
    frames: 3,
    ignored: "anything",
  });
  // Both generators are described even though Chat is the open tab.
  assert.ok(line.includes("Chat tab"));
  assert.ok(line.includes("Create (stills):"));
  assert.ok(line.includes("a fox"));
  assert.ok(line.includes("Edit on"));
  assert.ok(line.includes("9:16"));
  assert.ok(line.includes("4K"));
  assert.ok(line.includes("Video (clips):"));
  assert.ok(line.includes("MiniMax H3"));
  assert.ok(line.includes("9s"));
  assert.ok(line.includes("3 results already on the canvas"));
  assert.equal(line.includes("anything"), false);

  assert.equal(describeStudioState(undefined), "");
  assert.equal(describeStudioState({ tab: "settings" }), "");
});
