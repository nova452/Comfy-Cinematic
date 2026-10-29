/**
 * The Comfy Router account this app renders with.
 *
 * The header's "Sign in" takes an API key and checks it against the platform's
 * billing endpoint; the browser then keeps it (with the deployment and desktop
 * addresses and the prompt model) in its own storage and sends it with every
 * API call in the `x-comfy-studio` header. The server reads it for that one
 * request and never writes it anywhere, so each visitor renders on their own
 * key and their own Comfy.
 *
 * `PUBLIC_HOSTING=1` marks a shared, internet-facing deployment: the server's
 * own `COMFY_API_KEY` / `COMFY_LOCAL_API_KEY` are never lent to visitors, and
 * render targets must resolve to public addresses.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { normalizeThinking, type ThinkingLevel } from "./brain.ts";
import { requestSettings } from "./studio-settings.ts";

/** The endpoint comfy.org's own header reads credits from. */
export const BALANCE_URL = "https://cloud.comfy.org/api/billing/balance";

/** comfy.org renders credits as `round(cents × 211 / 100)`: 211 credits = $1. */
export const CREDITS_PER_CENT = 211 / 100;

export type Balance = {
  /** Whole credits, the number the header shows. */
  credits: number;
  /** Money left, in cents. */
  balanceCents: number;
  currency: string;
  low: boolean;
};

export type BalanceResult = { ok: true; balance: Balance } | { ok: false; status: number; error: string };

export type RenderTarget = "deployment" | "desktop";

/**
 * The prompt model settings saved with the account.
 *
 * They live next to the key rather than in the project so one machine-wide
 * choice governs every reference clip, and so the video route can read them
 * without trusting a client to send them.
 */
export type PromptSettings = {
  /** Model that rewrites prompts for audio and video reference clips. */
  brain?: string;
  /** How hard that model thinks before it writes. */
  thinking?: ThinkingLevel;
};

export type SavedAccount = {
  key: string;
  /** Hosted Comfy deployment (`https://dep-….run.comfy.app`). */
  deployment?: string;
  /** ComfyUI on this machine: directly, or behind `comfy-api-proxy`. */
  desktop?: string;
  /** Which of the two workflow renders use. */
  target: RenderTarget;
  savedAt: number;
} & PromptSettings;

export type AccountTargets = { deployment?: string; desktop?: string; target?: RenderTarget };

/** The address workflow renders run on, or undefined when that slot is empty. */
export function renderEndpoint(account: AccountTargets | undefined) {
  if (!account) return undefined;
  return account.target === "desktop" ? account.desktop : account.deployment;
}

/** `COMFY_BASE_URL`, when the server was started with one. */
export function environmentEndpoint(env: NodeJS.ProcessEnv = process.env) {
  return env.COMFY_BASE_URL?.trim() || undefined;
}

/**
 * What a workflow render actually uses. The environment wins: setting
 * `COMFY_BASE_URL` overrides both radio options.
 */
export function activeEndpoint(account: AccountTargets | undefined, env: NodeJS.ProcessEnv = process.env) {
  return environmentEndpoint(env) ?? renderEndpoint(account);
}

/**
 * A hosted Comfy surface — `https://dep-….run.comfy.app` or Comfy Cloud —
 * as opposed to a ComfyUI on this machine or the local network.
 *
 * The distinction matters for credentials: a deployment answers
 * `POST /api/v2/jobs` with 401 unless the Comfy key rides along, while a
 * self-hosted ComfyUI has no use for it at all.
 */
export function isHostedDeployment(endpoint: string) {
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "comfy.app" || host.endsWith(".comfy.app") || host === "cloud.comfy.org";
}

/**
 * The bearer to send with a workflow render.
 *
 * A hosted deployment needs the account's key: `dep-….run.comfy.app` refuses
 * an unauthenticated `/api/v2/jobs`. Anything else is someone's own ComfyUI,
 * which takes `COMFY_LOCAL_API_KEY` at most — the account key is this app's
 * credential, and handing it to a LAN address buys nothing.
 */
export function endpointKey(
  account: (SavedAccount | AccountTargets) | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const localKey = envLocalKey(env);
  const target = activeEndpoint(account, env);
  if (!target || !isHostedDeployment(target)) return localKey;
  const accountKey = (account as SavedAccount | undefined)?.key?.trim();
  return accountKey || envRouterKey(env) || localKey;
}

export function renderTargetLabel(target: RenderTarget | undefined) {
  return target === "desktop" ? "Comfy Desktop" : "Deployment";
}

export type DeploymentResult = { ok: true; url?: string } | { ok: false; error: string };

/**
 * A deployment root such as `https://dep-f639ca12-….run.comfy.app`.
 *
 * Blank clears it. It must be a bare http(s) URL: the SDK appends its own
 * `/api/v2/...` paths, so a query or fragment would be silently dropped.
 */
export function parseDeployment(value: unknown): DeploymentResult {
  if (value === undefined || value === null) return { ok: true, url: undefined };
  if (typeof value !== "string") return { ok: false, error: "The deployment must be a URL string." };

  const trimmed = value.trim();
  if (!trimmed) return { ok: true, url: undefined };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "That deployment is not a URL." };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "A deployment must start with https:// or http://." };
  }
  if (url.search || url.hash) {
    return { ok: false, error: "Drop the query string and fragment from the deployment URL." };
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${url.origin}${pathname}` };
}

/** `$1` is 211 credits; the number is rounded the way comfy.org rounds. */
export function creditsFromCents(cents: number) {
  return Math.round(cents * CREDITS_PER_CENT);
}

function centsOf(body: Record<string, unknown>, key: string) {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Read the balance envelope.
 *
 * `effective_balance_cents` is what Router billing actually draws from, so it
 * wins; the other fields are fallbacks for older/newer response shapes.
 */
export function readBalance(value: unknown): Balance | undefined {
  if (!value || typeof value !== "object") return undefined;
  const body = value as Record<string, unknown>;
  const cents =
    centsOf(body, "effective_balance_cents") ??
    centsOf(body, "prepaid_balance_cents") ??
    centsOf(body, "amount_cents") ??
    centsOf(body, "cloud_credit_balance_cents");
  if (cents === undefined) return undefined;

  return {
    credits: creditsFromCents(cents),
    balanceCents: Math.round(cents * 100) / 100,
    currency: typeof body.currency === "string" ? body.currency.toUpperCase() : "USD",
    low: body.low_balance === true,
  };
}

/** `comfyui-abc…wxyz` → `••••wxyz`, enough to tell two keys apart. */
export function maskKey(key: string) {
  const trimmed = key.trim();
  return trimmed.length <= 8 ? "••••" : `••••${trimmed.slice(-4)}`;
}

/** Ask Comfy what this key is worth. Never throws: the route wants a reason. */
export async function fetchBalance(key: string): Promise<BalanceResult> {
  let response: Response;
  try {
    response = await fetch(BALANCE_URL, {
      headers: { authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, status: 504, error: "Could not reach Comfy to check that key." };
  }

  if (!response.ok) {
    const refused = response.status === 401 || response.status === 403;
    return {
      ok: false,
      status: refused ? 401 : 502,
      error: refused ? "That key was refused by Comfy." : `Comfy answered ${response.status}.`,
    };
  }

  const body = await response.json().catch(() => undefined);
  const balance = readBalance(body);
  if (!balance) {
    return { ok: false, status: 502, error: "Comfy returned an unexpected balance." };
  }
  return { ok: true, balance };
}

/** A shared, internet-facing deployment: see the module comment. */
export function isPublicHosting(env: NodeJS.ProcessEnv = process.env) {
  return /^(1|true|yes)$/i.test(env.PUBLIC_HOSTING?.trim() ?? "");
}

/** The server's own Router key, unless it must not be lent to visitors. */
export function envRouterKey(env: NodeJS.ProcessEnv = process.env) {
  return isPublicHosting(env) ? undefined : env.COMFY_API_KEY?.trim() || undefined;
}

/** The server's own ComfyUI token, under the same rule. */
export function envLocalKey(env: NodeJS.ProcessEnv = process.env) {
  return isPublicHosting(env) ? undefined : env.COMFY_LOCAL_API_KEY?.trim() || undefined;
}

/**
 * Loopback, private, link-local, CGNAT, multicast and reserved ranges.
 *
 * On a public host these are the server's own network, not the visitor's, so
 * a render target there would let anyone make the server call them.
 */
export function isPrivateAddress(address: string) {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]!);

  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(ip) === 6) {
    return ip === "::" || ip === "::1" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip);
  }
  return false;
}

/**
 * Whether this server may call `endpoint` for a visitor.
 *
 * Always true off `PUBLIC_HOSTING`: a self-hosted studio is meant to reach the
 * ComfyUI next to it. On a public host every address the name resolves to has
 * to be public.
 */
export async function isAllowedEndpoint(endpoint: string, env: NodeJS.ProcessEnv = process.env) {
  if (!isPublicHosting(env)) return true;
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return false;
  }
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return false;
  }
  if (isIP(host.replace(/^\[|\]$/g, ""))) return !isPrivateAddress(host);
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every((entry) => !isPrivateAddress(entry.address));
  } catch {
    return false;
  }
}

/** The account fields a browser stored, re-validated. Unknown values drop out. */
export function normalizeAccount(raw: unknown): SavedAccount | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const parsed = raw as Record<string, unknown>;
  const key = typeof parsed.key === "string" ? parsed.key.trim() : "";
  if (!key || key.length > 400 || /\s/.test(key)) return undefined;

  const deployment = parseDeployment(parsed.deployment);
  const desktop = parseDeployment(parsed.desktop);
  const deploymentUrl = deployment.ok ? deployment.url : undefined;
  const desktopUrl = desktop.ok ? desktop.url : undefined;
  const brain = typeof parsed.brain === "string" ? parsed.brain.trim() : "";
  const thinking = normalizeThinking(parsed.thinking);

  // No `target`: infer it from what is filled in.
  const target: RenderTarget =
    parsed.target === "desktop" || parsed.target === "deployment"
      ? parsed.target
      : deploymentUrl && !desktopUrl
        ? "deployment"
        : "desktop";

  return {
    key,
    ...(deploymentUrl ? { deployment: deploymentUrl } : {}),
    ...(desktopUrl ? { desktop: desktopUrl } : {}),
    target,
    ...(brain ? { brain } : {}),
    ...(thinking ? { thinking } : {}),
    savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
  };
}

/**
 * The account this request was made with, from the browser's settings header.
 *
 * On a public host, a target that points into the server's own network is
 * dropped here, so no route can be talked into calling it.
 */
export async function readAccount(
  source: Request | Headers | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SavedAccount | undefined> {
  const account = normalizeAccount(requestSettings(source).account);
  if (!account) return undefined;

  const [deploymentOk, desktopOk] = await Promise.all([
    account.deployment ? isAllowedEndpoint(account.deployment, env) : true,
    account.desktop ? isAllowedEndpoint(account.desktop, env) : true,
  ]);
  if (!deploymentOk) delete account.deployment;
  if (!desktopOk) delete account.desktop;
  return account;
}

/** The key every render should use: the browser's, then (self-hosted only) the env one. */
export async function routerKey(source: Request | Headers | undefined, env: NodeJS.ProcessEnv = process.env) {
  const account = normalizeAccount(requestSettings(source).account);
  return account?.key || envRouterKey(env);
}

/**
 * How a request to a visitor's Comfy should treat a redirect.
 *
 * A public host does not follow one: the address it was pointed at is checked,
 * and a 302 could lead somewhere that check never saw. A self-hosted studio
 * follows, which is what a proxy answering http?https needs.
 */
export function redirectMode(): RequestRedirect {
  return isPublicHosting() ? "manual" : "follow";
}
