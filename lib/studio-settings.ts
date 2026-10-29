/**
 * The per-browser settings envelope.
 *
 * Every visitor keeps their own Comfy key, render targets and local model
 * names in their browser. The client sends them with each API call in one
 * header; the server reads them for that request only and never stores them.
 *
 * Pure and isomorphic so the browser, the routes and `node:test` share it.
 */

export const SETTINGS_HEADER = "x-comfy-studio";

/** Generous for a key, two URLs and a few model names; a backstop, not a budget. */
const MAX_HEADER = 8 * 1024;

export type StudioSettings = {
  account?: Record<string, unknown>;
  localModel?: Record<string, unknown>;
  localImage?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Base64 of UTF-8 JSON, since header values must be Latin-1. */
export function encodeSettings(settings: StudioSettings): string {
  const bytes = new TextEncoder().encode(JSON.stringify(settings));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeSettings(value: string | null | undefined): StudioSettings {
  if (!value || value.length > MAX_HEADER) return {};
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(parsed)) return {};
    return {
      ...(isRecord(parsed.account) ? { account: parsed.account } : {}),
      ...(isRecord(parsed.localModel) ? { localModel: parsed.localModel } : {}),
      ...(isRecord(parsed.localImage) ? { localImage: parsed.localImage } : {}),
    };
  } catch {
    return {};
  }
}

/** The settings a request carried, or `{}`. */
export function requestSettings(source: Request | Headers | undefined): StudioSettings {
  if (!source) return {};
  const headers = source instanceof Headers ? source : source.headers;
  return decodeSettings(headers.get(SETTINGS_HEADER));
}
