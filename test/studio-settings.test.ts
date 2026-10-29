import assert from "node:assert/strict";
import test from "node:test";
import { SETTINGS_HEADER, decodeSettings, encodeSettings, requestSettings } from "../lib/studio-settings.ts";
import { normalizeStoredAccount, normalizeStoredSettings, readSettings, writeSettings } from "../lib/client-settings.ts";

const ACCOUNT = {
  key: "comfyui-0123456789abcdef",
  deployment: "https://dep-a.run.comfy.app",
  target: "deployment" as const,
  brain: "anthropic/claude-opus-5-5",
  thinking: "high" as const,
};

test("the settings header survives a round trip", () => {
  const settings = {
    account: ACCOUNT,
    localModel: { unet: "a.safetensors", clip: "b.safetensors", steps: 12 },
    localImage: { unet: "c.safetensors", clip: "d.safetensors", steps: 20 },
  };

  assert.deepEqual(decodeSettings(encodeSettings(settings)), settings);
});

test("the header is base64, so a key never has to be Latin-1", () => {
  const encoded = encodeSettings({ account: { key: "comfyui-ünicode" } });
  assert.match(encoded, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(decodeSettings(encoded).account?.key, "comfyui-ünicode");
});

test("garbage in the header reads as no settings", () => {
  assert.deepEqual(decodeSettings(undefined), {});
  assert.deepEqual(decodeSettings(""), {});
  assert.deepEqual(decodeSettings("not base64 at all"), {});
  assert.deepEqual(decodeSettings(Buffer.from("[]").toString("base64")), {});
  // A value larger than the header cap is refused rather than parsed.
  assert.deepEqual(decodeSettings("A".repeat(9000)), {});
});

test("unknown settings fields are dropped", () => {
  const value = encodeSettings({ account: { key: "comfyui-key" }, junk: true } as never);
  assert.deepEqual(decodeSettings(value), { account: { key: "comfyui-key" } });
});

test("a request's settings are read from its header", () => {
  const request = new Request("http://localhost/api/account", {
    headers: { [SETTINGS_HEADER]: encodeSettings({ account: ACCOUNT }) },
  });
  assert.equal(requestSettings(request).account?.key, ACCOUNT.key);
  assert.deepEqual(requestSettings(new Request("http://localhost/api/account")), {});
  assert.deepEqual(requestSettings(new Headers()), {});
  assert.deepEqual(requestSettings(undefined), {});
});

test("a stored account is validated field by field", () => {
  assert.deepEqual(normalizeStoredAccount(ACCOUNT), ACCOUNT);

  // No key means no account: everything else hangs off it.
  assert.equal(normalizeStoredAccount({ deployment: "https://dep-a.run.comfy.app" }), undefined);
  assert.equal(normalizeStoredAccount({ key: "has space" }), undefined);
  assert.equal(normalizeStoredAccount({ key: "   " }), undefined);
  assert.equal(normalizeStoredAccount("comfyui-key"), undefined);

  // An unknown target or thinking level drops out rather than being repaired.
  const odd = normalizeStoredAccount({ key: "comfyui-key", target: "cloud", thinking: "extreme" });
  assert.deepEqual(odd, { key: "comfyui-key" });
});

test("stored local model names are clamped the way a render would be", () => {
  const settings = normalizeStoredSettings({
    account: ACCOUNT,
    localModel: { unet: "a", clip: "b", steps: 9999 },
  });

  assert.equal(settings.localModel?.steps, 200);
  assert.equal(settings.localModel?.unet, "a");
  assert.equal(settings.account?.key, ACCOUNT.key);
  assert.equal(settings.localImage, undefined);
});

test("this browser's settings survive a write and a read", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
  const fake = globalThis as { window?: unknown };
  const previous = fake.window;
  fake.window = { localStorage: storage, dispatchEvent: () => true };

  try {
    assert.deepEqual(readSettings(), {});
    writeSettings({ account: ACCOUNT, localModel: { unet: "a", clip: "b", steps: 5 } });
    assert.equal(readSettings().account?.key, ACCOUNT.key);
    assert.equal(readSettings().localModel?.steps, 5);

    storage.setItem("cinematic.settings", "{not json");
    assert.deepEqual(readSettings(), {});
  } finally {
    fake.window = previous;
  }
});
