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
    openjutsu: {
      unet: "e.safetensors",
      clip: "f.safetensors",
      steps: 16,
      openRouterKey: "sk-or-key",
      openjutsuMode: "light",
    },
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

test("an OpenRouter key saved before the split moves to Openjutsu's own record", () => {
  const settings = normalizeStoredSettings({
    localModel: {
      unet: "h3.safetensors",
      clip: "clip.safetensors",
      steps: 8,
      refVideoEdge: 480,
      openRouterKey: "sk-or-legacy",
    },
  });

  // The key now belongs to Openjutsu, which starts from the old shared files.
  assert.equal(settings.openjutsu?.openRouterKey, "sk-or-legacy");
  assert.equal(settings.openjutsu?.unet, "h3.safetensors");
  assert.equal(settings.localModel?.openRouterKey, undefined);
  assert.equal(settings.localModel?.refVideoEdge, 480);

  // Once Openjutsu has its own record, the two are independent.
  const split = normalizeStoredSettings({
    localModel: { unet: "h3.safetensors", clip: "clip.safetensors", steps: 8 },
    openjutsu: { unet: "ref5.safetensors", clip: "ref5-clip.safetensors", steps: 12, openRouterKey: "sk-or-own" },
  });
  assert.equal(split.localModel?.unet, "h3.safetensors");
  assert.equal(split.openjutsu?.unet, "ref5.safetensors");
  assert.equal(split.openjutsu?.openRouterKey, "sk-or-own");
});

test("each local video model reads its own settings header record", async () => {
  const { readLocalConfig, readOpenjutsuConfig } = await import("../lib/local-config.ts");
  const request = new Request("http://localhost/api/video", {
    headers: {
      [SETTINGS_HEADER]: encodeSettings({
        localModel: { unet: "h3.safetensors", clip: "h3-clip.safetensors", steps: 8 },
        openjutsu: {
          unet: "ref5.safetensors",
          clip: "ref5-clip.safetensors",
          steps: 12,
          openRouterKey: "sk-or-own",
          openjutsuMode: "light",
        },
      }),
    },
  });
  const env = {} as NodeJS.ProcessEnv;

  const local = await readLocalConfig(request, env);
  assert.equal(local.unet, "h3.safetensors");
  assert.equal(local.openRouterKey, undefined);

  const openjutsu = await readOpenjutsuConfig(request, env);
  assert.equal(openjutsu.unet, "ref5.safetensors");
  assert.equal(openjutsu.steps, 12);
  assert.equal(openjutsu.openRouterKey, "sk-or-own");
  assert.equal(openjutsu.openjutsuMode, "light");

  // A header written before the split has only `localModel`; Openjutsu still
  // reads it, so its key and file names keep working until it is saved once.
  const legacy = new Request("http://localhost/api/video", {
    headers: {
      [SETTINGS_HEADER]: encodeSettings({
        localModel: { unet: "old.safetensors", clip: "old-clip.safetensors", steps: 8, openRouterKey: "sk-or-old" },
      }),
    },
  });
  const fallback = await readOpenjutsuConfig(legacy, env);
  assert.equal(fallback.unet, "old.safetensors");
  assert.equal(fallback.openRouterKey, "sk-or-old");
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
