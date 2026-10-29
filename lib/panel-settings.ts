/**
 * The panel a project reopens with.
 *
 * Kept pure and storage-agnostic — reading is a `getItem`, writing is a
 * `setItem` — so what a stored panel may contain, and how a corrupt one is
 * treated, is unit tested instead of discovered on reload.
 *
 * Attachments are deliberately absent. A reference is the uploaded bytes
 * themselves, and a reload asks for them again rather than stashing megabytes
 * of base64 in the browser store.
 */

export const PANEL_TABS = ["create", "video", "chat", "assets"] as const;

export type PanelTab = (typeof PANEL_TABS)[number];

/** The panel's textareas cap at 900 characters; a stored draft obeys the same. */
export const PANEL_TEXT_MAX = 900;

/**
 * The settings worth reopening with.
 *
 * Ids are stored as ids, not validated against this build's lists: the panel
 * already knows how to fall back from a model, shape or size it no longer
 * offers, and a recipe from a newer build must not make the reload fail.
 */
export type PanelSettings = {
  tab?: PanelTab;
  prompt?: string;
  imageModel?: string;
  imageRatio?: string;
  imageResolution?: string;
  imageBatch?: number;
  videoPrompt?: string;
  videoModel?: string;
  videoRatio?: string;
  videoResolution?: string;
  videoDuration?: number;
  chatDraft?: string;
};

/** Anything that holds strings by key — `window.localStorage` qualifies. */
export type PanelStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** One key per project, so two canvases keep different panels. */
export function panelStorageKey(projectId: string) {
  return `cinematic.panel.${projectId}`;
}

function readText(value: unknown, max: number) {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A stored panel field by field; anything unusable is simply left out. */
export function normalizePanelSettings(raw: unknown): PanelSettings {
  const value =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  return {
    tab: PANEL_TABS.find((tab) => tab === value.tab),
    prompt: readText(value.prompt, PANEL_TEXT_MAX),
    imageModel: readText(value.imageModel, 64),
    imageRatio: readText(value.imageRatio, 16),
    imageResolution: readText(value.imageResolution, 16),
    imageBatch: readNumber(value.imageBatch),
    videoPrompt: readText(value.videoPrompt, PANEL_TEXT_MAX),
    videoModel: readText(value.videoModel, 64),
    videoRatio: readText(value.videoRatio, 16),
    videoResolution: readText(value.videoResolution, 16),
    videoDuration: readNumber(value.videoDuration),
    chatDraft: readText(value.chatDraft, PANEL_TEXT_MAX),
  };
}

/** One project's panel, or null when nothing usable was stored. */
export function readPanelSettings(store: PanelStore, projectId: string): PanelSettings | null {
  try {
    const raw = store.getItem(panelStorageKey(projectId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return normalizePanelSettings(parsed);
  } catch {
    // Unreadable JSON, a blocked store: the panel starts from its defaults.
    return null;
  }
}

/** Store a panel, tolerating a full, disabled or absent store. */
export function writePanelSettings(store: PanelStore, projectId: string, settings: PanelSettings) {
  try {
    store.setItem(panelStorageKey(projectId), JSON.stringify(settings));
  } catch {
    // Only the next reload is affected; the panel still works now.
  }
}
