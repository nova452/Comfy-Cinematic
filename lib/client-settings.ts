/**
 * The browser's own copy of everything the server used to keep in `.data/`:
 * the Comfy key, the render targets, the prompt model and the local model
 * names.
 *
 * One `localStorage` entry, sent with every API call in the
 * `x-comfy-studio` header. Nothing is uploaded or stored server-side, so
 * signing in on a public deployment changes nothing for anyone else.
 */

import { localImageModelConfig, type LocalImageModelConfig } from "./harness.ts";
import { localModelConfig, type LocalModelConfig } from "./video.ts";
import { encodeSettings, SETTINGS_HEADER, type StudioSettings } from "./studio-settings.ts";

const STORAGE_KEY = "cinematic.settings";

/** Fired on `window` whenever the settings change in this tab. */
export const SETTINGS_EVENT = "cinematic:settings";

export type StoredAccount = {
  key: string;
  deployment?: string;
  desktop?: string;
  target?: "deployment" | "desktop";
  /** Model that rewrites prompts for audio and video reference clips. */
  brain?: string;
  thinking?: "low" | "medium" | "high";
};

export type StoredSettings = {
  account?: StoredAccount;
  localModel?: LocalModelConfig;
  localImage?: LocalImageModelConfig;
};

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function store(): Store | undefined {
  try {
    return window.localStorage;
  } catch {
    // Private mode with storage disabled: every call falls back to defaults.
    return undefined;
  }
}

function text(value: unknown, max: number) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** A stored account, field by field; a key is what makes it an account. */
export function normalizeStoredAccount(raw: unknown): StoredAccount | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const key = text(value.key, 400);
  if (!key || /\s/.test(key)) return undefined;

  return {
    key,
    ...(text(value.deployment, 400) ? { deployment: text(value.deployment, 400) } : {}),
    ...(text(value.desktop, 400) ? { desktop: text(value.desktop, 400) } : {}),
    ...(value.target === "desktop" || value.target === "deployment" ? { target: value.target } : {}),
    ...(text(value.brain, 120) ? { brain: text(value.brain, 120) } : {}),
    ...(value.thinking === "low" || value.thinking === "medium" || value.thinking === "high"
      ? { thinking: value.thinking }
      : {}),
  };
}

export function normalizeStoredSettings(raw: unknown): StoredSettings {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const account = normalizeStoredAccount(value.account);
  return {
    ...(account ? { account } : {}),
    ...(value.localModel ? { localModel: localModelConfig(value.localModel) } : {}),
    ...(value.localImage ? { localImage: localImageModelConfig(value.localImage) } : {}),
  };
}

/** Everything this browser remembers. Never throws. */
export function readSettings(): StoredSettings {
  const target = store();
  if (!target) return {};
  try {
    const raw = target.getItem(STORAGE_KEY);
    return raw ? normalizeStoredSettings(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

/** Replace what this browser remembers. A blocked store is not an error. */
export function writeSettings(settings: StoredSettings) {
  const target = store();
  try {
    target?.setItem(STORAGE_KEY, JSON.stringify(normalizeStoredSettings(settings)));
  } catch {
    // A full or disabled store only costs the next reload.
  }
  try {
    window.dispatchEvent(new Event(SETTINGS_EVENT));
  } catch {
    // Not a browser (a test, a server render): nothing to notify.
  }
}

/** Keep an account, replacing the last one. */
export function rememberAccount(account: StoredAccount) {
  writeSettings({ ...readSettings(), account });
}

/** Forget the key and every target that went with it. */
export function forgetAccount() {
  const { account: _account, ...rest } = readSettings();
  writeSettings(rest);
}

export function rememberLocalModel(config: LocalModelConfig) {
  writeSettings({ ...readSettings(), localModel: localModelConfig(config) });
}

export function rememberLocalImage(config: LocalImageModelConfig) {
  writeSettings({ ...readSettings(), localImage: localImageModelConfig(config) });
}

/** Call `listener` when the settings change here or in another tab. */
export function onSettingsChange(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener(SETTINGS_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SETTINGS_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * `fetch` with this browser's settings attached.
 *
 * Same-origin only: the header carries the key, so a cross-origin call would
 * hand it to whatever host the URL names.
 */
export function apiFetch(input: string, init: RequestInit = {}) {
  const settings: StudioSettings = readSettings();
  const headers = new Headers(init.headers);
  if (Object.keys(settings).length > 0) headers.set(SETTINGS_HEADER, encodeSettings(settings));
  return fetch(input, { ...init, headers });
}
