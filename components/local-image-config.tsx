"use client";

import { useEffect, useState } from "react";
import { LOCAL_IMAGE_DEFAULTS, localImageModelConfig, type LocalImageModelConfig } from "../lib/harness";
import { apiFetch, readSettings, rememberLocalImage } from "../lib/client-settings";

/**
 * The gear on the "FLUX 3 Local" row.
 *
 * Same contract as the H3 dialog: the values are kept in this browser and are
 * what the next local render uses. Verify asks the active render target what
 * its loaders can actually see, so a typo is one click from being found — and
 * a render that failed on a missing checkpoint opens this dialog with that
 * check already done.
 */
export function LocalImageConfigDialog({
  onClose,
  autoVerify = false,
}: {
  onClose: () => void;
  autoVerify?: boolean;
}) {
  const [draft, setDraft] = useState<{ unet: string; clip: string; steps: string }>({
    unet: LOCAL_IMAGE_DEFAULTS.unet,
    clip: LOCAL_IMAGE_DEFAULTS.clip,
    steps: String(LOCAL_IMAGE_DEFAULTS.steps),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{
    checked?: boolean;
    host?: string;
    unet?: { name: string; found?: boolean };
    clip?: { name: string; found?: boolean };
    note?: string;
    error?: string;
  } | null>(null);

  useEffect(() => {
    const saved = readSettings().localImage;
    if (saved) {
      setDraft({ unet: saved.unet, clip: saved.clip, steps: String(saved.steps) });
      // Opened by a failed render: check the names it just tried.
      if (autoVerify) {
        void verify({ unet: saved.unet, clip: saved.clip });
        return;
      }
    }
    if (autoVerify) void verify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unetStatus = verifyResult?.checked
    ? verifyResult.unet?.found === true
      ? "ok"
      : verifyResult.unet?.found === false
        ? "bad"
        : undefined
    : undefined;
  const clipStatus = verifyResult?.checked
    ? verifyResult.clip?.found === true
      ? "ok"
      : verifyResult.clip?.found === false
        ? "bad"
        : undefined
    : undefined;
  const verifyBanner =
    verifyResult && !verifyResult.checked
      ? { text: verifyResult.error ?? verifyResult.note ?? "Could not check this target.", bad: true }
      : verifyResult?.checked && verifyResult.note
        ? { text: verifyResult.note, bad: false }
        : null;

  async function verify(overrides?: { unet?: string; clip?: string }) {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const response = await apiFetch("/api/local-image/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          unet: (overrides?.unet ?? draft.unet).trim(),
          clip: (overrides?.clip ?? draft.clip).trim(),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        checked?: boolean;
        host?: string;
        unet?: { name: string; found?: boolean };
        clip?: { name: string; found?: boolean };
        note?: string;
        error?: string;
      };
      if (!response.ok) {
        setVerifyResult({ error: data.error ?? `Verification failed (${response.status}).` });
        return;
      }
      setVerifyResult(data);
    } catch {
      setVerifyResult({ error: "Could not reach the app server." });
    } finally {
      setVerifying(false);
    }
  }

  function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    const unet = draft.unet.trim();
    const clip = draft.clip.trim();
    const steps = Number(draft.steps);
    if (!unet || !clip) {
      setError("Both model names are required.");
      setBusy(false);
      return;
    }
    if (!Number.isFinite(steps) || steps < 1 || steps > 200) {
      setError("Steps must be a whole number from 1 to 200.");
      setBusy(false);
      return;
    }

    rememberLocalImage(localImageModelConfig({ unet, clip, steps: Math.round(steps) }));
    onClose();
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Configure FLUX 3 Local" onClick={onClose}>
      <div className="modal account-modal model-config" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>FLUX 3 Local</h2>
          <button
            type="button"
            className="account-verify"
            onClick={() => void verify()}
            disabled={busy || verifying || !draft.unet.trim() || !draft.clip.trim()}
          >
            {verifying ? "Checking…" : "Verify"}
          </button>
          <button type="button" aria-label="Close configuration" onClick={onClose}>
            ✕
          </button>
        </header>

        {verifyBanner && (
          <p className={`verify-banner${verifyBanner.bad ? " is-bad" : ""}`} role="status">
            {verifyBanner.text}
          </p>
        )}

        <form className="account-form" onSubmit={save}>
          <label htmlFor="local-image-unet">Model name</label>
          <div className="field">
            <input
              id="local-image-unet"
              className={unetStatus === "ok" ? "is-ok" : unetStatus === "bad" ? "is-bad" : undefined}
              value={draft.unet}
              autoComplete="off"
              spellCheck={false}
              placeholder="flux3-image-klein-int8-convrot0.safetensors"
              disabled={busy}
              onChange={(event) => {
                setVerifyResult(null);
                setDraft((current) => ({ ...current, unet: event.target.value }));
              }}
            />
            {unetStatus && (
              <span className={`field-mark ${unetStatus}`} aria-hidden="true">
                {unetStatus === "ok" ? "✓" : "✗"}
              </span>
            )}
          </div>

          <label htmlFor="local-image-clip">Text encoder name</label>
          <div className="field">
            <input
              id="local-image-clip"
              className={clipStatus === "ok" ? "is-ok" : clipStatus === "bad" ? "is-bad" : undefined}
              value={draft.clip}
              autoComplete="off"
              spellCheck={false}
              placeholder="qwen3vl_4b_fp8_scaled.safetensors"
              disabled={busy}
              onChange={(event) => {
                setVerifyResult(null);
                setDraft((current) => ({ ...current, clip: event.target.value }));
              }}
            />
            {clipStatus && (
              <span className={`field-mark ${clipStatus}`} aria-hidden="true">
                {clipStatus === "ok" ? "✓" : "✗"}
              </span>
            )}
          </div>

          <label htmlFor="local-image-steps">Steps</label>
          <input
            id="local-image-steps"
            type="number"
            min={1}
            max={200}
            value={draft.steps}
            disabled={busy}
            onChange={(event) => setDraft((current) => ({ ...current, steps: event.target.value }))}
          />

          {error && (
            <p className="account-error" role="alert">
              {error}
            </p>
          )}

          <div className="account-actions">
            <button type="button" className="account-cancel" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="account-save"
              disabled={busy || !draft.unet.trim() || !draft.clip.trim() || !draft.steps.trim()}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
