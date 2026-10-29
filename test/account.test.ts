import assert from "node:assert/strict";
import test from "node:test";
import {
  CREDITS_PER_CENT,
  activeEndpoint,
  creditsFromCents,
  endpointKey,
  envLocalKey,
  envRouterKey,
  environmentEndpoint,
  isAllowedEndpoint,
  isHostedDeployment,
  isPrivateAddress,
  maskKey,
  normalizeAccount,
  parseDeployment,
  readAccount,
  readBalance,
  renderEndpoint,
  renderTargetLabel,
  routerKey,
} from "../lib/account.ts";
import { SETTINGS_HEADER, encodeSettings } from "../lib/studio-settings.ts";

/** A server environment with the usual test defaults. */
function envOf(vars: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...vars };
}

/** A request carrying this browser's settings, the way the client sends them. */
function requestWith(settings: Parameters<typeof encodeSettings>[0]) {
  return new Request("http://localhost/api/account", {
    headers: { [SETTINGS_HEADER]: encodeSettings(settings) },
  });
}

test("credits follow the platform's 211-per-dollar rate", () => {
  assert.equal(CREDITS_PER_CENT, 2.11);
  assert.equal(creditsFromCents(0), 0);
  assert.equal(creditsFromCents(100), 211);
  assert.equal(creditsFromCents(406.849178), 858);
});

test("the balance envelope prefers the effective balance", () => {
  const balance = readBalance({
    amount_cents: 10,
    cloud_credit_balance_cents: 0,
    effective_balance_cents: 406.849178,
    prepaid_balance_cents: 400,
    currency: "usd",
    low_balance: true,
  });

  assert.ok(balance);
  assert.equal(balance.credits, 858);
  assert.equal(balance.balanceCents, 406.85);
  assert.equal(balance.currency, "USD");
  assert.equal(balance.low, true);
});

test("older or thinner envelopes still yield a balance", () => {
  assert.deepEqual(readBalance({ amount_cents: 100, currency: "usd" }), {
    credits: 211,
    balanceCents: 100,
    currency: "USD",
    low: false,
  });

  assert.equal(readBalance({ cloud_credit_balance_cents: 50 })?.credits, 106);
  assert.equal(readBalance(undefined), undefined);
  assert.equal(readBalance({ currency: "usd" }), undefined);
  assert.equal(readBalance({ effective_balance_cents: "nope" }), undefined);
});

test("a key is masked to its last four characters", () => {
  assert.equal(maskKey("comfyui-0123456789abcd"), "••••abcd");
  assert.equal(maskKey("  comfyui-0123456789wxyz  "), "••••wxyz");
  assert.equal(maskKey("short"), "••••");
});

test("a deployment is reduced to a bare http(s) root", () => {
  assert.deepEqual(parseDeployment("https://dep-f639ca12-ae7b.run.comfy.app"), {
    ok: true,
    url: "https://dep-f639ca12-ae7b.run.comfy.app",
  });
  assert.deepEqual(parseDeployment("  https://dep-abc.run.comfy.app//  "), {
    ok: true,
    url: "https://dep-abc.run.comfy.app",
  });
  assert.deepEqual(parseDeployment("http://127.0.0.1:8189"), { ok: true, url: "http://127.0.0.1:8189" });
  assert.deepEqual(parseDeployment("https://example.com/team/a/"), {
    ok: true,
    url: "https://example.com/team/a",
  });
});

test("a blank deployment clears it; nonsense is refused", () => {
  assert.deepEqual(parseDeployment(""), { ok: true, url: undefined });
  assert.deepEqual(parseDeployment("   "), { ok: true, url: undefined });
  assert.deepEqual(parseDeployment(undefined), { ok: true, url: undefined });

  assert.equal(parseDeployment("dep-abc").ok, false);
  assert.equal(parseDeployment("ftp://example.com").ok, false);
  assert.equal(parseDeployment("https://example.com?token=1").ok, false);
  assert.equal(parseDeployment(42).ok, false);
});

test("the active target decides which address renders use", () => {
  const deployment = "https://dep-f639ca12.run.comfy.app";
  const desktop = "http://127.0.0.1:8189";

  assert.equal(renderEndpoint({ deployment, desktop, target: "deployment" }), deployment);
  assert.equal(renderEndpoint({ deployment, desktop, target: "desktop" }), desktop);

  // The unselected slot does not rescue an empty one.
  assert.equal(renderEndpoint({ deployment, target: "desktop" }), undefined);
  assert.equal(renderEndpoint({ desktop, target: "deployment" }), undefined);
  assert.equal(renderEndpoint(undefined), undefined);

  assert.equal(renderTargetLabel("desktop"), "Comfy Desktop");
  assert.equal(renderTargetLabel("deployment"), "Deployment");
  assert.equal(renderTargetLabel(undefined), "Deployment");
});

test("a hosted deployment needs the account key; a local ComfyUI does not", () => {
  const env = (vars: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
    NODE_ENV: "test",
    ...vars,
  });
  const hosted = {
    key: "comfyui-account-key",
    deployment: "https://dep-a.run.comfy.app",
    desktop: "http://127.0.0.1:8189",
    target: "deployment" as const,
  };
  const desktop = { ...hosted, target: "desktop" as const };

  assert.equal(isHostedDeployment("https://dep-a.run.comfy.app"), true);
  assert.equal(isHostedDeployment("https://cloud.comfy.org"), true);
  assert.equal(isHostedDeployment("http://127.0.0.1:8189"), false);
  assert.equal(isHostedDeployment("http://192.168.0.250:7248"), false);
  assert.equal(isHostedDeployment("not a url"), false);

  // A deployment authenticates; the key comes from the signed-in account.
  assert.equal(endpointKey(hosted, env()), "comfyui-account-key");
  assert.equal(endpointKey(hosted, env({ COMFY_API_KEY: "comfyui-env-key" })), "comfyui-account-key");
  // COMFY_BASE_URL wins the target, so it decides the credential too.
  assert.equal(
    endpointKey(hosted, env({ COMFY_BASE_URL: "https://dep-b.run.comfy.app" })),
    "comfyui-account-key",
  );

  // Nobody's own ComfyUI gets the Router credential.
  assert.equal(endpointKey(desktop, env()), undefined);
  assert.equal(endpointKey(desktop, env({ COMFY_API_KEY: "comfyui-env-key" })), undefined);
  assert.equal(endpointKey(desktop, env({ COMFY_LOCAL_API_KEY: " local-token " })), "local-token");
  assert.equal(endpointKey(undefined, env()), undefined);

  // A hosted deployment with no saved account still uses the environment key.
  assert.equal(
    endpointKey({ deployment: "https://dep-a.run.comfy.app", target: "deployment" }, env({ COMFY_API_KEY: "comfyui-env-key" })),
    "comfyui-env-key",
  );
});

test("COMFY_BASE_URL overrides the saved targets", () => {
  const account = {
    deployment: "https://dep-a.run.comfy.app",
    desktop: "http://127.0.0.1:8189",
    target: "deployment" as const,
  };
  const env = (vars: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
    NODE_ENV: "test",
    ...vars,
  });

  assert.equal(activeEndpoint(account, env()), "https://dep-a.run.comfy.app");
  assert.equal(activeEndpoint(account, env({ COMFY_BASE_URL: " http://127.0.0.1:9000 " })), "http://127.0.0.1:9000");
  assert.equal(activeEndpoint(undefined, env({ COMFY_BASE_URL: "http://x.test" })), "http://x.test");
  assert.equal(activeEndpoint(undefined, env()), undefined);
  assert.equal(environmentEndpoint(env({ COMFY_BASE_URL: "   " })), undefined);
});

test("an account is read from the browser's settings header", async () => {
  const request = requestWith({
    account: {
      key: "comfyui-0123456789abcdef",
      deployment: "https://dep-a.run.comfy.app",
      desktop: "http://127.0.0.1:8189",
      target: "desktop",
      brain: "anthropic/claude-sonnet-5",
      thinking: "high",
    },
  });

  const saved = await readAccount(request, envOf());
  assert.equal(saved?.key, "comfyui-0123456789abcdef");
  assert.equal(saved?.desktop, "http://127.0.0.1:8189");
  assert.equal(saved?.target, "desktop");
  assert.equal(saved?.brain, "anthropic/claude-sonnet-5");
  assert.equal(saved?.thinking, "high");
});

test("a request without settings has no account and no router key", async () => {
  const bare = new Request("http://localhost/api/account");
  assert.equal(await readAccount(bare, envOf()), undefined);
  assert.equal(await routerKey(bare, envOf()), undefined);
  assert.equal(await readAccount(requestWith({}), envOf()), undefined);
});

test("an account without a prompt model still reads", () => {
  const saved = normalizeAccount({
    key: "comfyui-old",
    target: "desktop",
    savedAt: 1,
  });

  assert.equal(saved?.key, "comfyui-old");
  // Unset means "whatever the reference default is", not "nothing works".
  assert.equal(saved?.brain, undefined);
  assert.equal(saved?.thinking, undefined);
});

test("a browser's key wins over the server's own", async () => {
  const env = envOf({ COMFY_API_KEY: "comfyui-env-key" });
  const request = requestWith({ account: { key: "comfyui-browser-key" } });
  assert.equal(await routerKey(request, env), "comfyui-browser-key");
  assert.equal(await routerKey(new Request("http://localhost"), env), "comfyui-env-key");
});

test("a public host never lends its own keys", () => {
  const env = envOf({
    PUBLIC_HOSTING: "1",
    COMFY_API_KEY: "comfyui-env-key",
    COMFY_LOCAL_API_KEY: "local-token",
  });
  assert.equal(envRouterKey(env), undefined);
  assert.equal(envLocalKey(env), undefined);
  // Self-hosted keeps the old behaviour.
  assert.equal(envRouterKey(envOf({ COMFY_API_KEY: "k" })), "k");
  assert.equal(envLocalKey(envOf({ COMFY_LOCAL_API_KEY: " t " })), "t");
});

test("private addresses are recognised", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.4", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test("a public host refuses private render targets", async () => {
  const hosting = envOf({ PUBLIC_HOSTING: "1" });
  assert.equal(await isAllowedEndpoint("https://dep-a.run.comfy.app", hosting), true);
  assert.equal(await isAllowedEndpoint("http://localhost:8189", hosting), false);
  assert.equal(await isAllowedEndpoint("http://127.0.0.1:8189", hosting), false);
  assert.equal(await isAllowedEndpoint("http://192.168.0.9:8189", hosting), false);
  assert.equal(await isAllowedEndpoint("http://comfy.local", hosting), false);

  // Self-hosted is meant to reach the machine next to it.
  assert.equal(await isAllowedEndpoint("http://127.0.0.1:8189", envOf()), true);
});

test("a public host drops a saved target inside its own network", async () => {
  const request = requestWith({
    account: { key: "comfyui-key", deployment: "http://10.0.0.5:8188", target: "deployment" },
  });
  const saved = await readAccount(request, envOf({ PUBLIC_HOSTING: "1" }));
  assert.equal(saved?.deployment, undefined);
  // The key is the visitor's and is still theirs.
  assert.equal(saved?.key, "comfyui-key");
});
