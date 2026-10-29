import { NextResponse } from "next/server";
import {
  activeEndpoint,
  envRouterKey,
  environmentEndpoint,
  fetchBalance,
  isAllowedEndpoint,
  maskKey,
  normalizeAccount,
  parseDeployment,
  readAccount,
  type Balance,
  type PromptSettings,
  type RenderTarget,
} from "../../../lib/account";
import { isBrainId, normalizeThinking, referencePrompt, type ThinkingLevel } from "../../../lib/brain";
import { requestSettings } from "../../../lib/studio-settings";

/**
 * The header's account control: what the browser's subscription is worth, and
 * a way to check new settings before the browser keeps them.
 *
 * Nothing is stored here. The browser holds the key, the render targets and
 * the prompt model, sends them in the `x-comfy-studio` header, and saves what
 * this route hands back. Responses carry only a masked tail of the key.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AccountPayload = {
  signedIn: boolean;
  /** Masked tail of the key, e.g. `••••wxyz`. */
  key?: string;
  /** Hosted Comfy deployment address. */
  deployment?: string;
  /** ComfyUI on this machine: directly, or behind `comfy-api-proxy`. */
  desktop?: string;
  /** Which of the two workflow renders use. */
  target?: RenderTarget;
  /** The address renders actually use, resolved from `target`. */
  endpoint?: string;
  /** `COMFY_BASE_URL` from the server environment, which overrides both slots. */
  envEndpoint?: string;
  balance?: Balance;
  /** Why a balance could not be read; the settings are still usable. */
  error?: string;
  /** The server has its own key, so renders already work without signing in. */
  envKey: boolean;
  /** Model that rewrites prompts for audio and video reference clips. */
  brain?: string;
  /** How hard that model thinks before it writes. */
  thinking?: ThinkingLevel;
};

/** What the browser should keep after a successful save. */
type SavedTargets = {
  deployment?: string;
  desktop?: string;
  target: RenderTarget;
  brain?: string;
  thinking?: ThinkingLevel;
};

function targets(account: { deployment?: string; desktop?: string; target?: RenderTarget }) {
  return {
    deployment: account.deployment,
    desktop: account.desktop,
    target: account.target ?? "deployment",
    endpoint: activeEndpoint(account),
    envEndpoint: environmentEndpoint(),
  };
}

/**
 * The reference prompt as it will actually run, defaults filled in.
 *
 * Sent on every response so the dialog shows the model in force rather than
 * the one that happens to be saved.
 */
function prompt(account: PromptSettings | undefined) {
  return referencePrompt(account);
}

const MIN_KEY = 8;
const MAX_KEY = 400;

function envKey() {
  return Boolean(envRouterKey());
}

export async function GET(request: Request) {
  const account = await readAccount(request);
  if (!account) {
    return NextResponse.json<AccountPayload>({ signedIn: false, envKey: envKey(), ...prompt(undefined) });
  }

  const result = await fetchBalance(account.key);
  return NextResponse.json<AccountPayload>({
    signedIn: true,
    key: maskKey(account.key),
    ...targets(account),
    ...prompt(account),
    envKey: envKey(),
    ...(result.ok ? { balance: result.balance } : { error: result.error }),
  });
}

/**
 * Check settings the dialog is about to keep.
 *
 * Returns the cleaned-up targets for the browser to store; the key itself is
 * never echoed back. A typed key is checked against the billing endpoint, so a
 * typo is refused here rather than on the next paid render.
 */
export async function POST(request: Request) {
  let body: {
    key?: unknown;
    deployment?: unknown;
    desktop?: unknown;
    target?: unknown;
    brain?: unknown;
    thinking?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Send a JSON request." }, { status: 400 });
  }

  const deployment = parseDeployment(body.deployment);
  if (!deployment.ok) {
    return NextResponse.json({ error: deployment.error }, { status: 400 });
  }

  const desktop = parseDeployment(body.desktop);
  if (!desktop.ok) {
    return NextResponse.json({ error: desktop.error }, { status: 400 });
  }

  // A public host must not be pointed at its own network.
  if (deployment.url && !(await isAllowedEndpoint(deployment.url))) {
    return NextResponse.json({ error: "That deployment is not a public address." }, { status: 400 });
  }
  if (desktop.url && !(await isAllowedEndpoint(desktop.url))) {
    return NextResponse.json({ error: "That Comfy address is not a public address." }, { status: 400 });
  }

  // The prompt model is an allowlist, the same one the picker draws from: an
  // unknown id here would only fail later, inside a render.
  const brainDraft = typeof body.brain === "string" ? body.brain.trim() : "";
  if (brainDraft && !isBrainId(brainDraft)) {
    return NextResponse.json({ error: "Pick one of the prompt models." }, { status: 400 });
  }

  const thinkingDraft = typeof body.thinking === "string" ? body.thinking.trim() : "";
  if (thinkingDraft && !normalizeThinking(thinkingDraft)) {
    return NextResponse.json({ error: "Thinking must be low, medium or high." }, { status: 400 });
  }

  // Keep the choice honest: if the selected slot is empty but the other one is
  // filled, follow the one that has an address.
  const requested: RenderTarget = body.target === "desktop" ? "desktop" : "deployment";
  const requestedUrl = requested === "desktop" ? desktop.url : deployment.url;
  const otherUrl = requested === "desktop" ? deployment.url : desktop.url;
  const target: RenderTarget = requestedUrl || !otherUrl ? requested : requested === "desktop" ? "deployment" : "desktop";

  const typedKey = typeof body.key === "string" ? body.key.trim() : "";
  if (typedKey && (typedKey.length < MIN_KEY || typedKey.length > MAX_KEY || /\s/.test(typedKey))) {
    return NextResponse.json({ error: "Paste a Comfy Router API key." }, { status: 400 });
  }

  // Settings can be saved without re-typing the key; the browser's one rides
  // in the header and is kept.
  const keptKey = normalizeAccount(requestSettings(request).account)?.key ?? "";
  const key = typedKey || keptKey;
  if (!key) {
    return NextResponse.json({ error: "Paste a Comfy Router API key." }, { status: 400 });
  }

  // A new key is checked before it is kept: a typo must not replace a working
  // one. A kept key is checked too, so the dialog can show its balance.
  const check = await fetchBalance(key);
  if (typedKey && !check.ok) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }

  const saved: SavedTargets = {
    ...(deployment.url ? { deployment: deployment.url } : {}),
    ...(desktop.url ? { desktop: desktop.url } : {}),
    target,
    ...(brainDraft ? { brain: brainDraft } : {}),
    ...(normalizeThinking(thinkingDraft) ? { thinking: normalizeThinking(thinkingDraft) } : {}),
  };

  return NextResponse.json<AccountPayload & { saved: SavedTargets }>({
    signedIn: true,
    key: maskKey(key),
    ...targets(saved),
    ...prompt(saved),
    ...(check.ok ? { balance: check.balance } : { error: check.error }),
    envKey: envKey(),
    saved,
  });
}
