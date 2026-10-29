import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKGROUND_CLAUSE,
  CHARACTER_CLAUSE,
  IMAGE_RATIOS,
  IMAGE_RESOLUTIONS,
  REFERENCE_CLAUSE,
  cleanImagePrompt,
  clampImageBatch,
  composePrompt,
  findImageRatio,
  findImageResolution,
  findImageTool,
  imageBatchOptions,
  imageRatioOptions,
  imageResolutionOptions,
  isMissingModelError,
  looksLikeQuestion,
  pickSubject,
  referenceClause,
  routePrompt,
  TOOLS,
  wantsImage,
} from "../lib/harness.ts";

test("answers questions about the setup locally", () => {
  const size = routePrompt("What size do you render?");
  assert.equal(size.intent, "answer");
  if (size.intent === "answer") {
    assert.equal(size.topic, "size");
    assert.match(size.answer, /1k/i);
  }

  const help = routePrompt("what can you do?");
  assert.equal(help.intent, "answer");
  if (help.intent === "answer") assert.equal(help.topic, "capabilities");
});

test("routes a description to the default tool", () => {
  const decision = routePrompt("A lighthouse in a storm, cinematic still");
  assert.equal(decision.intent, "image");
  if (decision.intent === "image") {
    assert.equal(decision.tool.model, "bfl/flux-3-image");
    assert.equal(decision.tool.aspectRatio, "1:1");
    assert.equal(decision.tool.resolution, "1k");
    assert.equal(decision.prompt, "A lighthouse in a storm, cinematic still");
  }
});

test("an image request wins over its question form", () => {
  const decision = routePrompt("Can you draw a cat?");
  assert.equal(decision.intent, "image");
  if (decision.intent === "image") assert.equal(decision.prompt, "Cat");
});

test("general knowledge questions get the honest fallback", () => {
  const decision = routePrompt("Why is the sky blue?");
  assert.equal(decision.intent, "answer");
  if (decision.intent === "answer") {
    assert.equal(decision.topic, "fallback");
    assert.match(decision.answer, /only answer questions about this setup/);
  }
});

test("short prompts without a question opener are treated as subjects", () => {
  assert.equal(routePrompt("a cat on a beach").intent, "image");
  assert.equal(routePrompt("hello").intent, "answer");
});

test("strips the command wrapper from an image request", () => {
  assert.equal(cleanImagePrompt("generate an image of a red fox."), "A red fox");
  assert.equal(cleanImagePrompt("please draw me a red fox"), "Red fox");
  assert.equal(cleanImagePrompt("show me a poster of a whale"), "A whale");
  assert.equal(cleanImagePrompt("a red fox"), "A red fox");
});

test("question and image signals are distinguishable", () => {
  assert.equal(looksLikeQuestion("what is this?"), true);
  assert.equal(looksLikeQuestion("a lighthouse?"), false);
  assert.equal(wantsImage("make me a poster"), true);
  assert.equal(wantsImage("what is a good prompt"), false);
});

test("caps the prompt length", () => {
  const decision = routePrompt("a".repeat(2000));
  assert.equal(decision.intent, "image");
  if (decision.intent === "image") assert.ok(decision.prompt.length <= 900);
});

test("empty input asks for something to do", () => {
  const decision = routePrompt("   ");
  assert.equal(decision.intent, "answer");
  if (decision.intent === "answer") assert.equal(decision.topic, "empty");
});

test("the registry offers FLUX 3 on Router and on local ComfyUI", () => {
  assert.equal(TOOLS.length, 2);
  assert.deepEqual(
    { model: TOOLS[0]!.model, ratio: TOOLS[0]!.aspectRatio, resolution: TOOLS[0]!.resolution },
    { model: "bfl/flux-3-image", ratio: "1:1", resolution: "1k" },
  );

  const local = TOOLS.find((tool) => tool.provider === "local");
  assert.ok(local);
  assert.equal(local.model, "local/flux-3-image");
  // The local edit graph takes reference images; only its text-to-image graph
  // has none, which the panel handles by mode rather than by hiding the tool.
  assert.notEqual(local.references, false);

  assert.equal(findImageTool("bfl/flux-3-image")?.id, TOOLS[0]!.id);
  assert.equal(findImageTool("local/flux-3-image"), local);
  assert.equal(findImageTool("nope"), undefined);
});

test("both tools offer FLUX 3's sixteen ratios and five size classes", () => {
  assert.equal(IMAGE_RATIOS.length, 16);
  assert.equal(IMAGE_RESOLUTIONS.length, 5);
  assert.deepEqual(
    IMAGE_RESOLUTIONS.map((option) => option.id),
    ["768sq", "1k", "1.5k", "2k", "4k"],
  );

  for (const tool of TOOLS) {
    assert.equal(tool.maxBatch, 4);
    assert.equal(imageRatioOptions(tool).length, 16);
    assert.equal(imageResolutionOptions(tool).length, 5);
    assert.deepEqual(imageBatchOptions(tool), [1, 2, 3, 4]);
  }
});

test("a stored ratio or size clamps into the model's own set", () => {
  assert.equal(findImageRatio("9:16"), "9:16");
  assert.equal(findImageRatio("auto"), "auto");
  assert.equal(findImageRatio("4:5"), "4:5");
  // Not in FLUX 3's schema, so the fallback wins instead of a paid 422.
  assert.equal(findImageRatio("3:1"), "1:1");
  assert.equal(findImageRatio("nonsense", "16:9"), "16:9");
  assert.equal(findImageRatio("4:5", "1:1", ["16:9", "1:1"]), "1:1");

  assert.equal(findImageResolution("4K"), "4k");
  assert.equal(findImageResolution("768sq"), "768sq");
  assert.equal(findImageResolution("8k"), "1k");
  assert.equal(findImageResolution("4k", "1k", ["768sq", "1k"]), "1k");
});

test("a batch is a whole number from one to four", () => {
  assert.equal(clampImageBatch(undefined), 1);
  assert.equal(clampImageBatch(0), 1);
  assert.equal(clampImageBatch("3"), 3);
  assert.equal(clampImageBatch(9), 4);
  assert.equal(clampImageBatch(2.6), 3);
  assert.equal(clampImageBatch(4, 2), 2);
});

test("composes subject, style phrase and reference clauses in order", () => {
  const composed = composePrompt("A fox in snow.", "cinematic film still", {
    characters: 1,
    background: true,
  });
  assert.equal(
    composed,
    `A fox in snow. cinematic film still. ${CHARACTER_CLAUSE} ${BACKGROUND_CLAUSE}`,
  );
  assert.ok(composed.indexOf(CHARACTER_CLAUSE) < composed.indexOf(BACKGROUND_CLAUSE));
});

test("adds only the clauses that were asked for", () => {
  assert.equal(composePrompt("A fox.", "", { background: true }), `A fox. ${BACKGROUND_CLAUSE}`);
  assert.equal(composePrompt("A fox.", "", { characters: 1 }), `A fox. ${CHARACTER_CLAUSE}`);
  assert.equal(composePrompt("A fox in snow.", "", {}), "A fox in snow.");
  assert.equal(composePrompt("A fox in snow.", "", { characters: 0, background: false }), "A fox in snow.");
});

test("one reference image gets one generic clause", () => {
  assert.equal(composePrompt("A fox.", "", { reference: true }), `A fox. ${REFERENCE_CLAUSE}`);
  // The generic reference is the whole reference story, so the legacy pair is
  // ignored if a stale client sends both.
  assert.equal(
    composePrompt("A fox.", "", { reference: true, characters: 1, background: true }),
    `A fox. ${REFERENCE_CLAUSE}`,
  );
});

test("several reference images get one range clause", () => {
  assert.equal(
    referenceClause(3),
    "Use images 1-3 as references: keep each subject, its appearance and the setting consistent with them.",
  );
  assert.equal(composePrompt("A fox.", "", { references: 4 }), `A fox. ${referenceClause(4)}`);
});

test("canvas mode edits image 1", () => {
  assert.equal(
    composePrompt("Change the dress to red.", "", { canvas: true }),
    "Change the dress to red. Image 1 is the image to edit.",
  );
  assert.equal(
    composePrompt("Change the dress to red.", "", { canvas: true, references: 2 }),
    "Change the dress to red. Image 1 is the image to edit. Images 2-3 are references: keep each subject, its appearance and the setting consistent with them.",
  );
});

test("normalises whitespace and trailing punctuation", () => {
  assert.equal(composePrompt("  A   fox .. ", ""), "A fox.");
});

test("the AI prompt toggle decides which text is used", () => {
  const decision = routePrompt("a fox in snow");
  assert.equal(decision.intent, "image");
  if (decision.intent !== "image") return;

  assert.equal(pickSubject(decision, "a fox in snow", true), decision.prompt);
  assert.equal(pickSubject(decision, "a fox in snow", false), "a fox in snow");
});

test("a checkpoint the target lacks is recognised as one", () => {
  // The real text a local render comes back with, from this deployment.
  assert.equal(
    isMissingModelError(
      "comfyui /prompt 400: Prompt outputs failed validation. Node 1 (UNETLoader): Value not in list: unet_name: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors' not in ['fasth3_omniref_8step_pruned_int8_convrot.safetensors'].",
    ),
    true,
  );
  assert.equal(isMissingModelError("Value not in list: clip_name: 'x' not in ['a']"), true);
  // A long list comes back abbreviated, with a count instead of the names.
  assert.equal(
    isMissingModelError(
      "unet_name: 'flux3-image-klein-int8-convrot0.safetensors' not in (list of length 23)",
    ),
    true,
  );

  // Other failures must not open a model dialog.
  assert.equal(isMissingModelError("LoadAudio: [Errno 1094995529] Invalid data found"), false);
  assert.equal(isMissingModelError("The local render did not finish within 840s."), false);
  assert.equal(isMissingModelError(""), false);
});
