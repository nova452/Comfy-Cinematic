import assert from "node:assert/strict";
import test from "node:test";
import {
  PANEL_TEXT_MAX,
  normalizePanelSettings,
  panelStorageKey,
  readPanelSettings,
  writePanelSettings,
  type PanelStore,
  type PanelSettings,
} from "../lib/panel-settings.ts";

const PROJECT = "216220da-39bf-45c4-8434-133af982e28b";

type MemoryStore = PanelStore & { entries: Map<string, string> };

function memoryStore(initial: Record<string, string> = {}): MemoryStore {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

test("the panel key is per project", () => {
  assert.equal(panelStorageKey(PROJECT), `cinematic.panel.${PROJECT}`);
  assert.notEqual(panelStorageKey("a"), panelStorageKey("b"));
});

test("a saved panel keeps the model, shape, size and drafts", () => {
  const saved = normalizePanelSettings({
    tab: "video",
    prompt: "a lone pigeon",
    imageModel: "local/flux-3-image",
    imageRatio: "16:9",
    imageResolution: "2k",
    imageBatch: 3,
    videoPrompt: "a storm over the pier",
    videoModel: "fal/h3-max",
    videoRatio: "9:16",
    videoResolution: "480P",
    videoDuration: 9,
    chatDraft: "how big is the canvas?",
  });

  assert.deepEqual<PanelSettings>(saved, {
    tab: "video",
    prompt: "a lone pigeon",
    imageModel: "local/flux-3-image",
    imageRatio: "16:9",
    imageResolution: "2k",
    imageBatch: 3,
    videoPrompt: "a storm over the pier",
    videoModel: "fal/h3-max",
    videoRatio: "9:16",
    videoResolution: "480P",
    videoDuration: 9,
    chatDraft: "how big is the canvas?",
  });
});

test("a tab this build does not have is dropped", () => {
  assert.equal(normalizePanelSettings({ tab: "settings" }).tab, undefined);
  assert.equal(normalizePanelSettings({ tab: 3 }).tab, undefined);
  assert.equal(normalizePanelSettings({ tab: "assets" }).tab, "assets");
});

test("fields of the wrong type are dropped rather than repaired", () => {
  const saved = normalizePanelSettings({
    prompt: 42,
    imageModel: false,
    imageResolution: ["2k"],
    imageBatch: "4",
    videoDuration: Number.NaN,
    chatDraft: null,
  });

  assert.equal(saved.prompt, undefined);
  assert.equal(saved.imageModel, undefined);
  assert.equal(saved.imageResolution, undefined);
  assert.equal(saved.imageBatch, undefined);
  assert.equal(saved.videoDuration, undefined);
  assert.equal(saved.chatDraft, undefined);
});

test("prompts and drafts obey the panel's own cap", () => {
  const long = "x".repeat(PANEL_TEXT_MAX + 200);
  const saved = normalizePanelSettings({ prompt: long, videoPrompt: long, chatDraft: long });

  assert.equal(saved.prompt?.length, PANEL_TEXT_MAX);
  assert.equal(saved.videoPrompt?.length, PANEL_TEXT_MAX);
  assert.equal(saved.chatDraft?.length, PANEL_TEXT_MAX);
});

test("a missing, empty or corrupt entry reads as nothing", () => {
  const store = memoryStore();
  assert.equal(readPanelSettings(store, PROJECT), null);

  store.entries.set(panelStorageKey(PROJECT), "{not json");
  assert.equal(readPanelSettings(store, PROJECT), null);

  store.entries.set(panelStorageKey(PROJECT), "null");
  assert.equal(readPanelSettings(store, PROJECT), null);

  store.entries.set(panelStorageKey(PROJECT), "[1,2,3]");
  assert.equal(readPanelSettings(store, PROJECT), null);
});

test("a blocked store neither throws nor restores", () => {
  const blocked: PanelStore = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };

  assert.equal(readPanelSettings(blocked, PROJECT), null);
  assert.doesNotThrow(() => writePanelSettings(blocked, PROJECT, { prompt: "a fox" }));
});

test("one project's panel never leaks into another", () => {
  const store = memoryStore();
  writePanelSettings(store, "first", { prompt: "a fox", imageModel: "local/flux-3-image" });

  assert.equal(readPanelSettings(store, "second"), null);
  const first = readPanelSettings(store, "first");
  assert.equal(first?.prompt, "a fox");
  assert.equal(first?.imageModel, "local/flux-3-image");
});

test("a written panel reads back the same settings", () => {
  const store = memoryStore();
  writePanelSettings(store, PROJECT, {
    tab: "create",
    prompt: "a lone pigeon",
    imageModel: "local/flux-3-image",
    imageRatio: "16:9",
    imageResolution: "2k",
    imageBatch: 2,
    videoPrompt: "",
    videoModel: "minimax/minimax-h3",
    videoRatio: "16:9",
    videoResolution: "768P",
    videoDuration: 5,
    chatDraft: "",
  });

  const read = readPanelSettings(store, PROJECT);
  assert.equal(read?.tab, "create");
  assert.equal(read?.prompt, "a lone pigeon");
  assert.equal(read?.imageModel, "local/flux-3-image");
  assert.equal(read?.imageRatio, "16:9");
  assert.equal(read?.imageResolution, "2k");
  assert.equal(read?.imageBatch, 2);
  assert.equal(read?.videoModel, "minimax/minimax-h3");
  assert.equal(read?.videoRatio, "16:9");
  assert.equal(read?.videoResolution, "768P");
  assert.equal(read?.videoDuration, 5);
});
