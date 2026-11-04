"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { dataUrlFromBlob } from "../lib/client-image";
import { apiFetch, readSettings } from "../lib/client-settings";
import { encodeSettings, SETTINGS_HEADER } from "../lib/studio-settings";
import { GIFT_LIMITS } from "../lib/gift";
import { isMissingModelError } from "../lib/harness";

/**
 * Gifting from this browser: the gift button and window, and the watcher that
 * renders friends' requests on this browser's own account.
 *
 * Both talk to `/api/gifting/*`, which answers only this machine, so on any
 * other copy of the app (ai.studio, a friend's) the button never shows and the
 * watcher stops after one check.
 */

/** Fired on `window` when this tab turns gifting on or off or mints a link. */
const GIFTING_EVENT = "cinematic:gifting";

/** Asks an open project to show Openjutsu's file settings (project-workspace.tsx). */
export const FIX_OPENJUTSU = "cinematic:fix-openjutsu";

/** Where this browser's tabs share what the gift host says. */
const GIFT_NOTES = "cinematic:gift-notes";

/** How often a gifting tab checks in; the relay calls it offline after 15s. */
const CHECK_IN_MS = 4000;

type GiftLinkRow = {
  id: string;
  createdAt: number;
  expiresAt: number;
  status: "active" | "used" | "revoked";
  attempts: number;
  videoUrl?: string;
  /** The request it made, while the relay still holds it. */
  job?: { status: string };
  /** Why its last try failed; the friend never sees this. */
  lastError?: string;
};

/**
 * Where a link stands, for its row. A used link is "In use" only while its
 * request is still on its way; one whose tries all failed, or whose request
 * a restart dropped, is used up.
 */
function linkState(link: GiftLinkRow) {
  if (link.status === "active") return link.attempts > 0 ? "retry" : "waiting";
  if (link.videoUrl) return "delivered";
  const running =
    link.job && link.job.status !== "done" && link.job.status !== "failed";
  return running ? "in-use" : "used-up";
}

type GiftingStatus = {
  enabled: boolean;
  relay: string | null;
  tunnel: boolean;
  tunnelError?: string;
  hostOnline: boolean;
  links: GiftLinkRow[];
};

type GiftJobInput = {
  prompt: string;
  auto: boolean;
  characters: string[];
  video: string;
  start?: number;
};

function announce() {
  window.dispatchEvent(new Event(GIFTING_EVENT));
}

function hoursLeft(expiresAt: number) {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 1
    ? `${hours}h left`
    : `${Math.max(1, Math.round(ms / 60_000))}m left`;
}

/** The tiny gift icon in a project's header, and the window it opens. */
export function GiftButton() {
  const [status, setStatus] = useState<GiftingStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [fresh, setFresh] = useState<{ id: string; url: string }>();
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/gifting", { cache: "no-store" });
      // Not this machine's copy: there is nothing to gift from here.
      if (!response.ok) return setStatus(null);
      setStatus((await response.json()) as GiftingStatus);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(GIFTING_EVENT, onChange);
    return () => window.removeEventListener(GIFTING_EVENT, onChange);
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    // Links get used and expire while the window is open.
    const timer = window.setInterval(() => void refresh(), 5000);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, refresh]);

  if (!status) return null;

  async function call(input: string, init: RequestInit) {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(input, init);
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok)
        throw new Error(
          data.error ?? `Gifting answered HTTP ${response.status}.`,
        );
      return data;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Gifting did not answer.",
      );
      return undefined;
    } finally {
      setBusy(false);
      announce();
    }
  }

  async function createLink() {
    const data = (await call("/api/gifting/links", { method: "POST" })) as
      { id: string; url: string } | undefined;
    if (data) {
      setFresh({ id: data.id, url: data.url });
      setCopied(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const shown = status.links
    .filter(
      (link) =>
        link.status !== "revoked" &&
        (link.status === "used" || link.expiresAt > Date.now()),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  const active = shown.filter((link) => link.status === "active").length;

  return (
    <>
      <button
        type="button"
        className="icon-button gift-button"
        data-on={status.enabled && active > 0 ? "true" : undefined}
        aria-haspopup="dialog"
        aria-label="Gifts"
        title={
          status.enabled && active > 0
            ? `Gifting on: ${active} link${active === 1 ? "" : "s"}`
            : "Gifts"
        }
        onClick={() => setOpen(true)}
      >
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
        >
          <rect x="4" y="10" width="16" height="10" rx="1.5" />
          <path d="M3 7h18v3H3zM12 7v13M12 7c-1.5-3-5-3.5-5-1.2C7 7 12 7 12 7zM12 7c1.5-3 5-3.5 5-1.2C17 7 12 7 12 7z" />
        </svg>
      </button>

      {/* The header's blur would trap a fixed overlay inside it. */}
      {open &&
        createPortal(
          <div
            className="overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Gifts"
            onClick={() => setOpen(false)}
          >
            <div
              className="modal gift-panel"
              onClick={(event) => event.stopPropagation()}
            >
              <header>
                <h2>Gifts</h2>
                <button
                  type="button"
                  aria-label="Close gifts"
                  onClick={() => setOpen(false)}
                >
                  ✕
                </button>
              </header>

              <p className="gift-lede">
                A link gives a friend one Openjutsu Prime clip (
                {GIFT_LIMITS.openjutsuMode}, {GIFT_LIMITS.resolution},{" "}
                {GIFT_LIMITS.duration}s), rendered here on your account. It
                works once and lasts 24 hours. Keep this tab open while it is
                out.
              </p>

              <button
                type="button"
                className="gift-create"
                disabled={busy}
                onClick={() => void createLink()}
              >
                {busy ? "Working…" : "Create link"}
              </button>

              {fresh && (
                <div className="gift-fresh">
                  <input
                    readOnly
                    value={fresh.url}
                    aria-label="New gift link"
                    onFocus={(event) => event.target.select()}
                  />
                  <button type="button" onClick={() => void copy(fresh.url)}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              )}

              {error && <p className="gift-error">{error}</p>}

              {/* Only a tunnel that failed is news; one that is still starting is not. */}
              {status.enabled && !status.tunnel && status.tunnelError && (
                <p className="gift-note">{status.tunnelError}</p>
              )}

              {shown.length > 0 && (
                <ul className="gift-links">
                  {shown.map((link) => {
                    const state = linkState(link);
                    return (
                      <li key={link.id}>
                        <span>
                          {state === "retry"
                            ? `Open again (${link.attempts}/${GIFT_LIMITS.attempts} tries)`
                            : state === "waiting"
                              ? "Waiting for a friend"
                              : state === "delivered"
                                ? "Delivered"
                                : state === "in-use"
                                  ? "In use"
                                  : "Used up"}
                        </span>
                        {state === "retry" && link.lastError && (
                          <span className="gift-why" title={link.lastError}>
                            Last try: {link.lastError}
                          </span>
                        )}
                        <span className="gift-when">
                          {link.status === "active"
                            ? hoursLeft(link.expiresAt)
                            : ""}
                          {link.videoUrl && (
                            <a
                              href={link.videoUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              clip
                            </a>
                          )}
                        </span>
                        {link.status === "active" && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              if (fresh?.id === link.id) setFresh(undefined);
                              void call(
                                `/api/gifting/links?id=${encodeURIComponent(link.id)}`,
                                { method: "DELETE" },
                              );
                            }}
                          >
                            Revoke
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              <p className="gift-state">
                {status.enabled && active > 0
                  ? "Gifting is on. It turns off by itself when no links are left."
                  : "Gifting is off. Creating a link turns it on."}
              </p>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * Renders friends' gifts in this tab while gifting is on.
 *
 * It checks in every few seconds (that is what tells friends the host is
 * online), takes one request at a time, renders it through `/api/video` with
 * the gift's fixed settings, and reports back. Mounted once for the whole app.
 */
export function GiftHost() {
  /** What the host says; `fix` offers to open Openjutsu's file settings. */
  const [note, setNote] = useState<{
    text: string;
    tone?: "error";
    fix?: boolean;
  }>();
  const session = useRef<string>("");
  const working = useRef(false);
  const noteTimer = useRef(0);

  const channel = useRef<BroadcastChannel | null>(null);

  const show = useCallback(
    (text: string, tone?: "error", hold = false, fix = false) => {
      setNote({ text, tone, fix });
      window.clearTimeout(noteTimer.current);
      if (!hold)
        noteTimer.current = window.setTimeout(() => setNote(undefined), 6000);
    },
    [],
  );

  // Any of this browser's tabs may be the one that took a gift, so what it
  // says shows in every open tab of the app, not just the one rendering.
  const say = useCallback(
    (text: string, tone?: "error", hold = false, fix = false) => {
      show(text, tone, hold, fix);
      channel.current?.postMessage({ text, tone, hold, fix });
    },
    [show],
  );

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const shared = new BroadcastChannel(GIFT_NOTES);
    shared.onmessage = (
      event: MessageEvent<{
        text?: unknown;
        tone?: unknown;
        hold?: unknown;
        fix?: unknown;
      }>,
    ) => {
      if (typeof event.data?.text !== "string") return;
      show(
        event.data.text,
        event.data.tone === "error" ? "error" : undefined,
        event.data.hold === true,
        event.data.fix === true,
      );
    };
    channel.current = shared;
    return () => {
      shared.close();
      channel.current = null;
    };
  }, [show]);

  useEffect(() => {
    session.current ||= crypto.randomUUID();
    let timer = 0;
    let stopped = false;
    let owner = true;

    /** Tell the relay how a gift went; true when it took the news. */
    async function report(body: Record<string, unknown>) {
      try {
        const response = await fetch("/api/gifting/inbox", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session: session.current, ...body }),
        });
        return response.ok;
      } catch {
        return false;
      }
    }

    async function render(job: { id: string; input: GiftJobInput }) {
      working.current = true;
      say("Gift has been accepted, adding to queue...", undefined, true);
      const renderId = crypto.randomUUID();
      await report({ jobId: job.id, action: "started", renderId });

      // The gift's settings, whatever this browser's panel says: Light, no upscale.
      const settings = readSettings();
      const base = settings.openjutsu ?? settings.localModel;
      const giftSettings = {
        ...settings,
        ...(base
          ? {
              openjutsu: {
                ...base,
                openjutsuMode: GIFT_LIMITS.openjutsuMode,
                upscale: false,
              },
            }
          : {}),
      };
      try {
        const response = await fetch("/api/video", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SETTINGS_HEADER]: encodeSettings(giftSettings),
          },
          body: JSON.stringify({
            prompt: job.input.auto ? "" : job.input.prompt,
            mode: GIFT_LIMITS.mode,
            model: GIFT_LIMITS.model,
            resolution: GIFT_LIMITS.resolution,
            duration: GIFT_LIMITS.duration,
            characters: job.input.characters,
            video: job.input.video,
            ...(job.input.auto ? { auto: true } : {}),
            ...(job.input.start ? { start: job.input.start } : {}),
            renderId,
            enhance: true,
          }),
        });
        const data = (await response.json().catch(() => ({}))) as {
          src?: string;
          error?: string;
        };
        if (!response.ok || !data.src)
          throw new Error(
            data.error ??
              `The gift could not be rendered (HTTP ${response.status}).`,
          );
        say("Gift rendered, sending it to your friend…", undefined, true);
        const video = data.src.startsWith("data:")
          ? data.src
          : await dataUrlFromBlob(await (await fetch(data.src)).blob());
        // The relay answers only once the clip is safely up for the friend.
        if (!(await report({ jobId: job.id, action: "done", video }))) {
          throw new Error("The relay could not hand the clip over.");
        }
        say("Gift delivered.");
      } catch (cause) {
        const message =
          cause instanceof Error
            ? cause.message
            : "The gift could not be rendered.";
        await report({ jobId: job.id, action: "failed", error: message });
        // The full reason is for whoever debugs this machine, not a pop-up.
        console.warn("[gift] render failed:", message);
        // A model file the render target does not have is this browser's
        // Openjutsu settings, and the one failure the gifter can fix in a click.
        if (isMissingModelError(message)) {
          say(
            "Gift failed: Openjutsu's model files aren't on your render target.",
            "error",
            true,
            true,
          );
        } else {
          say("Gift failed.", "error");
        }
      } finally {
        void fetch(`/api/video/result?id=${encodeURIComponent(renderId)}`, {
          method: "DELETE",
        }).catch(() => {});
        working.current = false;
        announce();
      }
    }

    async function checkIn() {
      window.clearTimeout(timer);
      if (stopped || !owner) return;
      let enabled = false;
      try {
        // With this browser's settings: the server takes gifts only from a
        // tab that has somewhere to render them.
        const response = await apiFetch(
          `/api/gifting/inbox?session=${session.current}`,
          { cache: "no-store" },
        );
        // Another machine's copy: this tab never hosts.
        if (response.status === 403 || response.status === 404) {
          owner = false;
          return;
        }
        const data = (await response.json()) as {
          enabled?: boolean;
          job?: { id: string; input: GiftJobInput };
        };
        enabled = Boolean(data.enabled);
        if (data.job && !working.current) void render(data.job);
      } catch {
        // The app server is down for a moment; try again on the next tick.
        enabled = true;
      }
      // Gifting off: wait for this tab to turn it on rather than polling.
      if (enabled || working.current)
        timer = window.setTimeout(() => void checkIn(), CHECK_IN_MS);
    }

    const wake = () => void checkIn();
    window.addEventListener(GIFTING_EVENT, wake);
    void checkIn();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.clearTimeout(noteTimer.current);
      window.removeEventListener(GIFTING_EVENT, wake);
    };
  }, [say]);

  if (!note) return null;
  return (
    <div className="gift-toast" role="status" data-tone={note.tone}>
      {note.text}
      {note.fix && (
        <span className="gift-toast-actions">
          <button
            type="button"
            onClick={() => {
              // An open project shows Openjutsu's settings with the target's
              // real file lists; without one there is nowhere to show them.
              const event = new Event(FIX_OPENJUTSU, { cancelable: true });
              window.dispatchEvent(event);
              if (event.defaultPrevented) setNote(undefined);
              else
                setNote({
                  text: "Open a project, then the gear on the Openjutsu Prime row.",
                  tone: "error",
                });
            }}
          >
            Fix
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setNote(undefined)}
          >
            ✕
          </button>
        </span>
      )}
    </div>
  );
}
