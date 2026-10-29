import assert from "node:assert/strict";
import test from "node:test";
import {
  FLAVOR_BRAIN,
  FLAVOR_BRAINS,
  REFERENCE_BRAIN,
  REFERENCE_PROMPT_SPEC,
  REFERENCE_THINKING,
  acceptsThinking,
  acceptsVideo,
  buildBrainRequest,
  DEFAULT_BRAIN,
  formatPromptSpec,
  IMAGE_SYSTEM_PROMPT,
  isBrainId,
  isFlavorId,
  parseBrainDecision,
  parsePromptSpec,
  providerOf,
  readBrainText,
  referencePrompt,
  SYSTEM_PROMPT,
} from "../lib/brain.ts";

test("default brain is an anthropic model", () => {
  assert.equal(providerOf(DEFAULT_BRAIN), "anthropic");
  assert.ok(SYSTEM_PROMPT.includes("\"intent\""));
});

test("the Create prompt can only be rewritten, never answered", () => {
  // Generate is a render instruction, so this prompt has no answer branch for
  // the model to fall into.
  assert.ok(IMAGE_SYSTEM_PROMPT.includes("\"prompt\""));
  assert.ok(!IMAGE_SYSTEM_PROMPT.includes("\"intent\""));
  assert.ok(!IMAGE_SYSTEM_PROMPT.includes("\"answer\""));
});

test("builds the Anthropic Messages body without a model field", () => {
  const body = buildBrainRequest("anthropic/claude-haiku-4-5-20251001", "draw a cat");
  assert.equal(body.model, undefined);
  assert.equal(body.system, SYSTEM_PROMPT);
  assert.equal(body.max_tokens, 500);
  assert.deepEqual(body.messages, [{ role: "user", content: "draw a cat" }]);
});

test("builds the OpenAI Responses body without a model field", () => {
  const body = buildBrainRequest("openai/gpt-5-mini", "hello");
  assert.equal(body.model, undefined);
  assert.equal(body.instructions, SYSTEM_PROMPT);
  assert.equal(body.input, "hello");
  assert.equal(body.max_output_tokens, 1500);
  assert.equal(body.messages, undefined);
});

test("refuses a provider it has no adapter for", () => {
  assert.throws(() => buildBrainRequest("google/gemini-3.1-flash", "hi"), /No request adapter/);
});

test("reads Anthropic text blocks and ignores thinking", () => {
  const text = readBrainText("anthropic/claude-haiku-4-5-20251001", {
    content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "First." },
      { type: "text", text: "Second." },
    ],
  });
  assert.equal(text, "First.\nSecond.");
});

test("reads OpenAI Responses output", () => {
  assert.equal(readBrainText("openai/gpt-5-mini", { output_text: "ok" }), "ok");
  assert.equal(
    readBrainText("openai/gpt-5-mini", {
      output: [
        { type: "reasoning", summary: [] },
        { type: "message", content: [{ type: "output_text", text: "ok" }, { type: "refusal", refusal: "no" }] },
      ],
    }),
    "ok",
  );
  assert.equal(readBrainText("openai/gpt-5-mini", { output: [] }), undefined);
});

test("parses a bare decision", () => {
  assert.deepEqual(parseBrainDecision('{"intent":"answer","answer":"Blue light scatters."}'), {
    intent: "answer",
    answer: "Blue light scatters.",
  });
  assert.deepEqual(parseBrainDecision('{"intent":"image","image_prompt":"A red fox"}'), {
    intent: "image",
    prompt: "A red fox",
  });
});

test("parses a fenced or chatty reply", () => {
  const fenced = '```json\n{"intent":"answer","answer":"Yes."}\n```';
  assert.deepEqual(parseBrainDecision(fenced), { intent: "answer", answer: "Yes." });

  const chatty = 'Sure — here is the decision: {"intent":"image","image_prompt":"A fox"} done.';
  assert.deepEqual(parseBrainDecision(chatty), { intent: "image", prompt: "A fox" });
});

test("rejects decisions that are missing or malformed", () => {
  assert.equal(parseBrainDecision("no json here"), undefined);
  assert.equal(parseBrainDecision("{not json}"), undefined);
  assert.equal(parseBrainDecision('{"intent":"image"}'), undefined);
  assert.equal(parseBrainDecision('{"intent":"answer","answer":"  "}'), undefined);
  assert.equal(parseBrainDecision('{"intent":"other"}'), undefined);
});

test("caps the image prompt from the brain", () => {
  const decision = parseBrainDecision(JSON.stringify({ intent: "image", image_prompt: "x".repeat(2000) }));
  assert.equal(decision?.intent, "image");
  if (decision?.intent === "image") assert.equal(decision.prompt.length, 900);
});

test("reference clips run on the one model that can watch them", () => {
  assert.equal(REFERENCE_BRAIN, "vertexai/gemini-3.8-flash");
  assert.equal(REFERENCE_THINKING, "medium");
  assert.equal(acceptsVideo(REFERENCE_BRAIN), true);
  assert.equal(acceptsVideo(FLAVOR_BRAIN), false);
  assert.deepEqual(referencePrompt(undefined), { brain: REFERENCE_BRAIN, thinking: "medium" });
  assert.deepEqual(referencePrompt({}), { brain: REFERENCE_BRAIN, thinking: "medium" });
});

test("saved reference settings win, and stale ones fall back", () => {
  assert.deepEqual(referencePrompt({ brain: REFERENCE_BRAIN, thinking: "high" }), {
    brain: REFERENCE_BRAIN,
    thinking: "high",
  });

  // A removed model, a level nobody sent, or a model that cannot watch a clip
  // all fall back rather than failing the render or writing the shot blind.
  assert.deepEqual(referencePrompt({ brain: "anthropic/claude-2", thinking: "banana" }), {
    brain: REFERENCE_BRAIN,
    thinking: "medium",
  });
  assert.deepEqual(referencePrompt({ brain: FLAVOR_BRAIN, thinking: "high" }), {
    brain: REFERENCE_BRAIN,
    thinking: "high",
  });
});

test("thinking is sent the way each provider asks for it", () => {
  const anthropic = buildBrainRequest(FLAVOR_BRAIN, "a shot", SYSTEM_PROMPT, "medium");
  assert.deepEqual(anthropic.thinking, { type: "enabled", budget_tokens: 2048 });
  // Anthropic rejects a body whose ceiling is not above the budget.
  assert.equal(anthropic.max_tokens, 2048 + 700);

  const openai = buildBrainRequest("openai/gpt-5-mini", "a shot", SYSTEM_PROMPT, "high");
  assert.deepEqual(openai.reasoning, { effort: "high" });
  assert.equal(openai.thinking, undefined);

  const gemini = buildBrainRequest(REFERENCE_BRAIN, "a shot", SYSTEM_PROMPT, "low");
  assert.deepEqual(gemini.generationConfig, {
    maxOutputTokens: 1500,
    thinkingConfig: { thinkingLevel: "LOW" },
  });
});

test("a model with no reasoning knob is never handed one", () => {
  const body = buildBrainRequest("openai/gpt-4.1", "a shot", SYSTEM_PROMPT, "high");
  assert.equal(body.reasoning, undefined);
  assert.equal(body.max_output_tokens, 1500);
  assert.equal(acceptsThinking("openai/gpt-4.1"), false);
  assert.equal(acceptsThinking(REFERENCE_BRAIN), true);
});

test("the allowlist knows the reference model", () => {
  assert.equal(isBrainId(REFERENCE_BRAIN), true);
  assert.equal(isBrainId("anthropic/claude-2"), false);
  assert.equal(isBrainId(DEFAULT_BRAIN), true);
});

test("the flavor picker offers every enhancer, and only enhancers", () => {
  // Opus 5.5 stays the default, so the first row of the picker is unchanged.
  assert.equal(FLAVOR_BRAINS[0], FLAVOR_BRAIN);

  for (const id of FLAVOR_BRAINS) {
    assert.equal(isBrainId(id), true, id);
    assert.equal(isFlavorId(id), true, id);
    assert.equal(acceptsThinking(id), true, id);
    // Every flavor model must build a body, or the picker would offer a 500.
    assert.ok(buildBrainRequest(id, "a shot", SYSTEM_PROMPT, "medium"), id);
  }

  // Models that exist for other jobs are not flavor choices.
  assert.equal(isFlavorId(REFERENCE_BRAIN), false);
  assert.equal(isFlavorId(DEFAULT_BRAIN), false);
  assert.equal(isFlavorId("anthropic/claude-2"), false);
});

test("a pasted spec carries the model and its thinking", () => {
  assert.deepEqual(parsePromptSpec("anthropic/claude-opus-5-5/medium"), {
    brain: "anthropic/claude-opus-5-5",
    thinking: "medium",
  });
  assert.deepEqual(parsePromptSpec("openai/gpt-5-mini/high"), {
    brain: "openai/gpt-5-mini",
    thinking: "high",
  });

  // A level is optional; the reference default fills it in.
  assert.deepEqual(parsePromptSpec("anthropic/claude-sonnet-5"), {
    brain: "anthropic/claude-sonnet-5",
    thinking: "medium",
  });

  // Spaces are a paste artefact, not part of the id.
  assert.equal(parsePromptSpec("  anthropic/claude-sonnet-5 / low  ")?.thinking, "low");
  assert.deepEqual(parsePromptSpec(REFERENCE_PROMPT_SPEC), {
    brain: REFERENCE_BRAIN,
    thinking: REFERENCE_THINKING,
  });
});

test("a paste we cannot call is refused, not defaulted", () => {
  assert.equal(parsePromptSpec(""), undefined);
  assert.equal(parsePromptSpec("   "), undefined);
  assert.equal(parsePromptSpec("claude-opus-5-5/medium"), undefined);
  assert.equal(parsePromptSpec("anthropic/claude-2/medium"), undefined);
  // A level nobody knows stays glued to the model, which then fails the allowlist.
  assert.equal(parsePromptSpec("anthropic/claude-opus-5-5/banana"), undefined);
});

test("a spec survives a round trip through the field", () => {
  for (const spec of [REFERENCE_PROMPT_SPEC, "openai/gpt-4.1/low", "anthropic/claude-sonnet-5/high"]) {
    const parsed = parsePromptSpec(spec);
    assert.ok(parsed);
    assert.equal(formatPromptSpec(parsed), spec);
  }
});
