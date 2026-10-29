"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch, forgetAccount, readSettings, rememberAccount, type StoredAccount } from "../lib/client-settings";
import {
  REFERENCE_PROMPT_SPEC,
  acceptsVideo,
  formatPromptSpec,
  parsePromptSpec,
  referencePrompt,
  type ThinkingLevel,
} from "../lib/brain";

/**
 * Credits + account management for the top-right corner.
 *
 * The pill shows the workspace's credit count the way comfy.org's header does
 * (coins + number, avatar beside it). Its menu is deliberately short — Manage
 * account, Sign out — and the dialog behind "Manage account" is where the
 * balance, the deployment, the key and the refresh live.
 *
 * The key never leaves this browser: it is kept in `localStorage` and sent
 * with each render, so signing in here changes nothing for anyone else.
 */

type Balance = {
  credits: number;
  balanceCents: number;
  currency: string;
  low: boolean;
};

type RenderTarget = "deployment" | "desktop";

type Account = {
  signedIn: boolean;
  key?: string;
  deployment?: string;
  desktop?: string;
  target?: RenderTarget;
  endpoint?: string;
  envEndpoint?: string;
  balance?: Balance;
  error?: string;
  envKey: boolean;
  /** Model that rewrites prompts for audio and video reference clips. */
  brain?: string;
  /** How hard it thinks before it writes. */
  thinking?: ThinkingLevel;
  /** The cleaned-up settings to keep, on a successful save. */
  saved?: Omit<StoredAccount, "key">;
};

function CoinsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M13.744 17.736a6 6 0 1 1-7.48-7.48" strokeLinecap="round" />
      <path d="M15 6h1v4" strokeLinecap="round" />
      <path d="m6.134 14.768.866-.5 2 3.464" strokeLinecap="round" />
      <circle cx="16" cy="8" r="6" />
    </svg>
  );
}

function DeployIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
      <rect x="3" y="4" width="18" height="6" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
      <path d="M7 7h.01M7 17h.01" strokeLinecap="round" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
      <circle cx="8" cy="8" r="4.2" />
      <path d="M11 11l8 8M16.5 16.5l2-2M14 14l2-2" strokeLinecap="round" />
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <rect x="1.4" y="1.4" width="13.2" height="13.2" rx="3.4" />
      <circle cx="8" cy="6.2" r="2.1" />
      <path d="M4.4 12.6c.5-1.5 1.9-2.3 3.6-2.3s3.1.8 3.6 2.3" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <path d="m4.5 10 4-4-4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M6.2 1.4h-.5C4.2 1.4 3.3 2.3 3.3 3.8v8.4c0 1.5.9 2.4 2.4 2.4h.5" strokeLinecap="round" />
      <path d="M8.6 4.4 12.4 8l-3.8 3.6M12.1 8H6.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** `https://dep-abc.run.comfy.app` → `dep-abc.run.comfy.app` */
function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function AccountMenu() {
  const [account, setAccount] = useState<Account | undefined>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [deploymentDraft, setDeploymentDraft] = useState("");
  const [desktopDraft, setDesktopDraft] = useState("");
  const [targetDraft, setTargetDraft] = useState<RenderTarget>("desktop");
  const [specDraft, setSpecDraft] = useState<string>(REFERENCE_PROMPT_SPEC);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string>();
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await apiFetch("/api/account", { cache: "no-store" });
      if (!response.ok) return;
      setAccount((await response.json()) as Account);
    } catch {
      // Keep the last known balance rather than blanking the pill.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  useEffect(() => {
    if (dialogOpen) inputRef.current?.focus({ preventScroll: true });
  }, [dialogOpen]);

  useEffect(() => {
    if (!menuOpen && !dialogOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      setDialogOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen, dialogOpen]);

  function openDialog() {
    setFormError(undefined);
    setKeyDraft("");
    setDeploymentDraft(account?.deployment ?? "");
    setDesktopDraft(account?.desktop ?? "");
    setTargetDraft(account?.target ?? (account?.deployment ? "deployment" : "desktop"));
    setSpecDraft(formatPromptSpec(referencePrompt(account)));
    setMenuOpen(false);
    setDialogOpen(true);
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = keyDraft.trim();
    if (!account?.signedIn && !key) {
      setFormError("Paste a key first.");
      return;
    }

    // One pasted spec, read here so the dialog can point at the field instead
    // of failing the whole save on a typo the route would reject anyway.
    const prompt = parsePromptSpec(specDraft);
    if (!prompt) {
      setFormError("Paste a model and a thinking level, like anthropic/claude-opus-5-5/medium.");
      return;
    }
    // Only Google's models read video and audio, and this setting exists to
    // configure exactly the rewrite that needs to watch the clip.
    if (!acceptsVideo(prompt.brain)) {
      setFormError("Reference rewrites need a model that can watch the clip. Try vertexai/gemini-3.8-flash/medium.");
      return;
    }

    setBusy(true);
    setFormError(undefined);
    try {
      const response = await apiFetch("/api/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key,
          deployment: deploymentDraft,
          desktop: desktopDraft,
          target: targetDraft,
          brain: prompt.brain,
          thinking: prompt.thinking,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as Account & { error?: string };
      if (!response.ok) {
        setFormError(data.error ?? "Those settings could not be saved.");
        return;
      }
      // The server validated them; this browser is where they live.
      const kept = key || readSettings().account?.key;
      if (kept && data.saved) rememberAccount({ key: kept, ...data.saved });
      setAccount(data);
      setKeyDraft("");
      setDialogOpen(false);
    } catch {
      setFormError("Could not reach the app server.");
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    forgetAccount();
    setMenuOpen(false);
    setDialogOpen(false);
    setKeyDraft("");
    setAccount({ signedIn: false, envKey: account?.envKey ?? false });
  }

  const signedIn = account?.signedIn === true;
  const credits = account?.balance?.credits;
  const balanceLabel = account?.balance
    ? `${account.balance.currency === "USD" ? "$" : ""}${(account.balance.balanceCents / 100).toFixed(2)}`
    : undefined;
  const endpointHost = account?.endpoint ? hostOf(account.endpoint) : undefined;
  const envHost = account?.envEndpoint ? hostOf(account.envEndpoint) : undefined;
  const targetsLocked = Boolean(envHost);

  return (
    <div className="account" ref={wrapRef}>
      {signedIn ? (
        <button
          type="button"
          className="account-pill"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={credits === undefined ? "Comfy Router account" : `${credits.toLocaleString()} credits · ${balanceLabel} left`}
          onClick={() => {
            setMenuOpen((open) => !open);
            void refresh();
          }}
        >
          <span className={`account-credits${account?.balance?.low ? " is-low" : ""}`}>
            <CoinsIcon />
            {credits === undefined ? "–" : credits.toLocaleString()}
          </span>
          <span className="account-avatar" aria-hidden="true">
            <KeyIcon />
          </span>
        </button>
      ) : (
        <button
          type="button"
          className="account-pill is-signed-out"
          aria-haspopup="dialog"
          title="Sign in with a Comfy Router key"
          onClick={openDialog}
        >
          <span className="account-signin">Sign in</span>
          <span className="account-avatar" aria-hidden="true">
            <KeyIcon />
          </span>
        </button>
      )}

      {menuOpen && signedIn && (
        <div className="account-menu" role="menu" aria-label="Comfy Router account">
          <div className="account-menu-user">
            <span className="account-menu-avatar" aria-hidden="true">
              <KeyIcon />
            </span>
            <span className="account-menu-id">
              <span className="account-menu-name">{account?.key}</span>
              <span className="account-menu-plan">
                {credits === undefined ? "No balance" : `${credits.toLocaleString()} credits`}
              </span>
            </span>
          </div>

          <div className="account-menu-rule" role="separator" />

          <button type="button" role="menuitem" className="account-menu-item" onClick={openDialog}>
            <PersonIcon />
            <span>Manage account</span>
            <span className="account-menu-chevron">
              <ChevronIcon />
            </span>
          </button>

          <div className="account-menu-rule" role="separator" />

          <button
            type="button"
            role="menuitem"
            className="account-menu-item"
            onClick={() => void signOut()}
            disabled={busy}
          >
            <SignOutIcon />
            <span>Sign out</span>
          </button>
        </div>
      )}

      {dialogOpen &&
        createPortal(
          <div
            className="overlay"
            role="dialog"
            aria-modal="true"
            aria-label={signedIn ? "Manage your Comfy account" : "Sign in with a Comfy Router key"}
            onClick={() => setDialogOpen(false)}
          >
            <div className="modal account-modal" onClick={(event) => event.stopPropagation()}>
              <header>
                <h2>{signedIn ? "Manage account" : "Sign in"}</h2>
                <button type="button" aria-label="Close" onClick={() => setDialogOpen(false)}>
                  ✕
                </button>
              </header>

              {/* Signed in, the facts below speak for themselves; signed out,
                  this is the only place the key is explained. */}
              {!signedIn && (
                <p className="account-lede">
                  Paste a Router key. It is checked against Comfy, then kept in this browser and sent
                  only with your own renders.
                </p>
              )}

              {signedIn && (
                <div className="account-facts">
                  <div className="account-fact">
                    <span className="account-fact-icon">
                      <CoinsIcon />
                    </span>
                    <span className="account-fact-text">
                      <b>{credits === undefined ? "Balance unavailable" : `${credits.toLocaleString()} credits`}</b>
                      <span>{balanceLabel ? `${balanceLabel} left` : (account?.error ?? "No balance yet")}</span>
                    </span>
                    <button type="button" onClick={() => void refresh()} disabled={busy}>
                      Refresh
                    </button>
                  </div>

                  <div className="account-fact">
                    <span className="account-fact-icon">
                      <DeployIcon />
                    </span>
                    <span className="account-fact-text">
                      <b>{endpointHost ?? "No render target"}</b>
                      <span>
                        {envHost
                          ? "Set via environment"
                          : endpointHost
                            ? account?.target === "desktop"
                              ? "Comfy Desktop"
                              : "Deployment"
                            : "No address configured"}
                      </span>
                    </span>
                  </div>
                </div>
              )}

              <form className="account-form" onSubmit={save}>
                {!signedIn && (
                  <>
                    <label htmlFor="comfy-router-key">API key</label>
                    <input
                      id="comfy-router-key"
                      ref={inputRef}
                      type="password"
                      value={keyDraft}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="comfyui-…"
                      disabled={busy}
                      onChange={(event) => setKeyDraft(event.target.value)}
                    />
                  </>
                )}

                <fieldset className="account-targets">
                  <legend>Where local renders run</legend>

                  {envHost && (
                    <p className="account-env">
                      Set via environment · <b>{envHost}</b>. Overrides both options below.
                    </p>
                  )}

                  <div
                    className={`account-target${targetDraft === "deployment" ? " is-active" : ""}${
                      targetsLocked ? " is-locked" : ""
                    }`}
                  >
                    <input
                      id="target-deployment"
                      type="radio"
                      name="render-target"
                      checked={targetDraft === "deployment"}
                      onChange={() => setTargetDraft("deployment")}
                      disabled={busy || targetsLocked}
                    />
                    <label htmlFor="target-deployment" className="account-target-info">
                      <b>Deployment</b>
                      <span>Hosted Comfy build</span>
                    </label>
                    <input
                      className="account-target-url"
                      type="url"
                      value={deploymentDraft}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="https://dep-….run.comfy.app"
                      aria-label="Deployment address"
                      disabled={busy || targetsLocked}
                      onFocus={() => setTargetDraft("deployment")}
                      onChange={(event) => setDeploymentDraft(event.target.value)}
                    />
                  </div>

                  <div
                    className={`account-target${targetDraft === "desktop" ? " is-active" : ""}${
                      targetsLocked ? " is-locked" : ""
                    }`}
                  >
                    <input
                      id="target-desktop"
                      type="radio"
                      name="render-target"
                      checked={targetDraft === "desktop"}
                      onChange={() => setTargetDraft("desktop")}
                      disabled={busy || targetsLocked}
                    />
                    <label htmlFor="target-desktop" className="account-target-info">
                      <b>Comfy Desktop</b>
                      <span>Your ComfyUI, direct or behind comfy-api-proxy</span>
                    </label>
                    <input
                      className="account-target-url"
                      type="url"
                      value={desktopDraft}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="http://127.0.0.1:8189"
                      aria-label="Comfy Desktop address"
                      disabled={busy || targetsLocked}
                      onFocus={() => setTargetDraft("desktop")}
                      onChange={(event) => setDesktopDraft(event.target.value)}
                    />
                  </div>
                </fieldset>

                {/* The prompt model steers reference rewrites, which need a
                    signed-in account anyway; first sign-in stays two fields. */}
                {signedIn && (
                  <fieldset className="account-targets">
                    <legend>Prompt model</legend>

                    <div className="account-prompt">
                      <input
                        id="prompt-spec"
                        type="text"
                        value={specDraft}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={REFERENCE_PROMPT_SPEC}
                        aria-label="Prompt model"
                        aria-invalid={specDraft.trim() !== "" && !parsePromptSpec(specDraft)}
                        disabled={busy}
                        onChange={(event) => setSpecDraft(event.target.value)}
                      />
                    </div>
                  </fieldset>
                )}

                {formError && (
                  <p className="account-error" role="alert">
                    {formError}
                  </p>
                )}

                <div className="account-actions">
                  <button type="button" className="account-cancel" onClick={() => setDialogOpen(false)}>
                    Cancel
                  </button>
                  <button type="submit" className="account-save" disabled={busy || (!signedIn && !keyDraft.trim())}>
                    {busy ? "Checking…" : signedIn ? "Save" : "Sign in"}
                  </button>
                </div>
              </form>

              {account?.envKey && (
                <p className="account-note">This host has its own COMFY_API_KEY. Your signed-in key is used first.</p>
              )}

              {!signedIn && (
                <p className="account-foot">
                  Need a key?{" "}
                  <a
                    href="https://platform.comfy.org/profile/api-keys?onboarding=router"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Create one in the Comfy platform
                  </a>
                  .
                </p>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
