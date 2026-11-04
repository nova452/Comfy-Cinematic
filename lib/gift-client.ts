/**
 * A friend's side of a gift link: the token and relay it carries, kept per
 * project in this browser, and the calls that spend it.
 *
 * Nothing here touches this copy's own server. The relay is the gifter's
 * machine, reached through their tunnel; the token rides in the Authorization
 * header and never in a URL.
 */

import { HOST_OFF_MESSAGE } from "./gift.ts";

export { HOST_OFF_MESSAGE };

export type ProjectGift = {
  token: string;
  /** The gifter's relay, e.g. `https://….trycloudflare.com`. */
  host: string;
  /** The request in flight or finished, so a reload picks it back up. */
  jobId?: string;
  /** Its tile on the canvas. */
  slot?: { id: string; x: number; y: number; aspect?: number; prompt: string };
  /** When the request went out, for the tile's clock. */
  startedAt?: number;
  /** What the finished frame records (the canvas's clip meta). */
  meta?: unknown;
  /** The gift is spent: its clip is on the canvas. */
  spent?: boolean;
  /**
   * The gifter's relay has vouched for this link. Until it has, the project
   * is a plain one: a made-up token on an unreachable relay proves nothing.
   */
  confirmed?: boolean;
};

/**
 * The host's render, as its own tile sees it (`/api/video/progress`): the
 * friend's tile shows the same stage, steps and clock.
 */
export type GiftTrack = {
  stage: string;
  step?: number;
  steps?: number;
  node?: string;
  label: string;
  /** Seconds since the host's render started. */
  elapsed: number;
};

export type GiftJobView = {
  id: string;
  status: "waiting" | "accepted" | "rendering" | "uploading" | "done" | "failed";
  position?: number;
  /** The host's render, while it runs. */
  track?: GiftTrack;
  videoUrl?: string;
  error?: string;
  hostOnline: boolean;
};

const STORAGE_KEY = "cinematic.gifts";

function readAll(): Record<string, ProjectGift> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, ProjectGift>) : {};
  } catch {
    return {};
  }
}

export function readProjectGift(projectId: string): ProjectGift | undefined {
  const gift = readAll()[projectId];
  return gift && typeof gift.token === "string" && typeof gift.host === "string" ? gift : undefined;
}

/** The project a gift token already opened in this browser, if any. */
export function projectForGift(token: string) {
  const all = readAll();
  return Object.keys(all).find((id) => all[id]?.token === token);
}

export function writeProjectGift(projectId: string, gift: ProjectGift | undefined) {
  const all = readAll();
  if (gift) all[projectId] = gift;
  else delete all[projectId];
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage blocked: the gift still works until the page reloads.
  }
}

/** A relay address a link may name: https anywhere, http only on this machine. */
export function giftHostOk(host: string) {
  try {
    const url = new URL(host);
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** The gift a link's fragment carries (`#gift=…&host=…`), if it is well formed. */
export function giftFromFragment(hash: string): ProjectGift | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("gift")?.trim() ?? "";
  const host = (params.get("host")?.trim() ?? "").replace(/\/+$/, "");
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token) || !giftHostOk(host)) return undefined;
  return { token, host };
}

function relay(gift: ProjectGift, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${gift.token}`);
  return fetch(`${gift.host}${path}`, { ...init, headers, cache: "no-store" });
}

async function answer<T>(response: Response): Promise<T & { error?: string; code?: string }> {
  return (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };
}

/**
 * Where the link stands, by the relay's own answer: still free, already used
 * (with its request), or dead. `off` means no relay answered — the gifter's
 * app or tunnel is down — which says nothing either way about the token.
 */
export async function giftLinkState(
  gift: ProjectGift,
): Promise<
  { state: "active" } | { state: "used"; job: GiftJobView } | { state: "dead"; error: string } | { state: "off" }
> {
  let response: Response;
  try {
    response = await relay(gift, "/gift/link");
  } catch {
    return { state: "off" };
  }
  const data = await answer<{ status?: string; job?: GiftJobView }>(response);
  if (response.ok && data.status === "active") return { state: "active" };
  if (response.ok && data.status === "used" && data.job) return { state: "used", job: data.job };
  // Only the relay's own refusal of the token is final. A busy or failing
  // relay, or the tunnel's page for an origin that is gone (Cloudflare's
  // 502/530), says nothing about the link.
  if (!data.error || response.status === 429 || response.status >= 500) return { state: "off" };
  return { state: "dead", error: data.error };
}

export type GiftInput = { prompt: string; auto: boolean; characters: string[]; video: string; start?: number };

/** Hand the request to the gifter. A closed host or an unreachable tunnel is the same news. */
export async function submitGift(gift: ProjectGift, input: GiftInput): Promise<GiftJobView> {
  let response: Response;
  try {
    response = await relay(gift, "/gift/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    throw new Error(HOST_OFF_MESSAGE);
  }
  const data = await answer<GiftJobView>(response);
  if (!response.ok || !data.id) throw new Error(data.error ?? `The gift was not accepted (HTTP ${response.status}).`);
  return data;
}

/** The request's status, or undefined when the relay could not be reached this time. */
export async function giftJob(gift: ProjectGift, jobId: string): Promise<GiftJobView | { gone: string } | undefined> {
  try {
    const response = await relay(gift, `/gift/jobs/${encodeURIComponent(jobId)}`);
    const data = await answer<GiftJobView>(response);
    if (response.ok) return data;
    if (response.status === 404) return { gone: data.error ?? "The gifter no longer has this request." };
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The finished clip as a data URI: from the relay while it holds it, else
 * from litterbox. Undefined when neither lets this page download it; the
 * litterbox URL can still be played and saved by hand.
 */
export async function collectGiftVideo(gift: ProjectGift, job: GiftJobView): Promise<string | undefined> {
  const sources = [
    () => relay(gift, `/gift/jobs/${encodeURIComponent(job.id)}/video`),
    ...(job.videoUrl ? [() => fetch(job.videoUrl!, { cache: "no-store" })] : []),
  ];
  for (const source of sources) {
    try {
      const response = await source();
      if (!response.ok) continue;
      const blob = await response.blob();
      if (!blob.size) continue;
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob.type ? blob : new Blob([blob], { type: "video/mp4" }));
      });
    } catch {
      // Blocked or gone: try the next source.
    }
  }
  return undefined;
}
