import { NextResponse } from "next/server";
import { activeEndpoint, envLocalKey, envRouterKey, readAccount } from "../../../../lib/account";
import { readLocalConfig, readOpenjutsuConfig } from "../../../../lib/local-config";
import { loaderLists, type LoaderList } from "../../../../lib/model-lists";
import { ref6Files } from "../../../../lib/ref5";
import { OPENJUTSU_REFINER_LORAS, isRefinerLora } from "../../../../lib/video";

/** One more file Openjutsu loads; `key` names the Extras field it belongs to, if any. */
type FileCheck = {
  key: "ref2vaUnet" | "ref2vaLora" | "latentUpscaler" | "refinerLora";
  label: string;
  name: string;
  found?: boolean;
};

/**
 * Check the configured model names against the active render target.
 *
 * ComfyUI's `/object_info/<loader>` lists the files it can see. A deployment
 * does not expose that route — it only serves `/api/v2/...` — so there the
 * names are read back out of a validation-only probe job instead. Either way
 * the answer is a real list, not a guess.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const account = await readAccount(request);
  const target = activeEndpoint(account);
  if (!target) {
    return NextResponse.json({ error: "No render target is set." }, { status: 409 });
  }

  // Check what the dialog is showing, not what was last saved. The dialog
  // names its own record, since the two local video gears keep separate ones.
  type Body = {
    unet?: unknown;
    clip?: unknown;
    openjutsu?: unknown;
    ref2vaUnet?: unknown;
    ref2vaLora?: unknown;
    latentUpscaler?: unknown;
    refinerLora?: unknown;
  };
  let body: Body = {};
  try {
    body = (await request.json()) as Body;
  } catch {
    // No body: fall back to the saved configuration.
  }

  const saved =
    body.openjutsu === true ? await readOpenjutsuConfig(request) : await readLocalConfig(request);
  const unetName = typeof body.unet === "string" && body.unet.trim() ? body.unet.trim() : saved.unet;
  const clipName = typeof body.clip === "string" && body.clip.trim() ? body.clip.trim() : saved.clip;
  // Extras, as the dialog shows them; blank means the default.
  const drafted = (value: unknown, fallback?: string) =>
    typeof value === "string" ? value.trim() || undefined : fallback;
  const ref2vaUnet = drafted(body.ref2vaUnet, saved.ref2vaUnet);
  const ref2vaLora = drafted(body.ref2vaLora, saved.ref2vaLora);
  const latentUpscaler = drafted(body.latentUpscaler, saved.latentUpscaler);
  const wantedRefiner = drafted(body.refinerLora, saved.refinerLora);

  let host = target;
  let local = false;
  try {
    host = new URL(target).host;
    local = ["127.0.0.1", "localhost", "::1"].includes(new URL(target).hostname);
  } catch {
    // A malformed saved target is reported by the fetch below.
  }

  const kind = account?.deployment === target ? "deployment" : account?.desktop === target ? "desktop" : local ? "desktop" : "deployment";
  const key = local ? envLocalKey() : account?.key || envRouterKey();

  const openjutsu = body.openjutsu === true;
  let unet: LoaderList;
  let clip: LoaderList;
  let lora: LoaderList | undefined;
  let upscaler: LoaderList | undefined;
  try {
    ({ unet, clip, lora, upscaler } = await loaderLists(target, key, openjutsu));
  } catch {
    return NextResponse.json({ target, kind, host, error: `Could not reach ${host}.` }, { status: 502 });
  }

  if (!unet.ok && !clip.ok) {
    return NextResponse.json({
      target,
      kind,
      host,
      checked: false,
      note:
        unet.status === 404 || clip.status === 404
          ? `${host} does not expose /object_info and did not answer the v2 probe, so the file names cannot be listed there.`
          : `${host} refused the check (HTTP ${unet.status}).`,
    });
  }

  // Openjutsu also loads the pass-2 checkpoint and LoRA, the latent upscaler
  // and the refiner LoRA. The refiner comes in two ranks and either will do:
  // the one the target lists is reported back, and the dialog saves it.
  let files: FileCheck[] | undefined;
  let refinerLora: string | undefined;
  if (openjutsu) {
    const names = ref6Files({ ref2vaUnet, ref2vaLora, latentUpscaler, refinerLora: wantedRefiner });
    const has = (list: LoaderList | undefined, name: string) => (list?.ok ? list.options.includes(name) : undefined);
    const listed = lora?.ok ? lora.options.filter(isRefinerLora) : [];
    // The one asked for if the target has it, else the first release it does.
    refinerLora =
      (wantedRefiner && lora?.ok && lora.options.includes(wantedRefiner) ? wantedRefiner : undefined) ??
      OPENJUTSU_REFINER_LORAS.map((release) => listed.find((name) => name.endsWith(release))).find(Boolean);
    files = [
      { key: "ref2vaUnet", label: "Second pass model", name: names.ref2vaUnet, found: has(unet, names.ref2vaUnet) },
      { key: "ref2vaLora", label: "Second pass LoRA", name: names.ref2vaLora, found: has(lora, names.ref2vaLora) },
      {
        key: "latentUpscaler",
        label: "Latent upscaler",
        name: names.latentUpscaler,
        found: has(upscaler, names.latentUpscaler),
      },
      {
        key: "refinerLora",
        label: "Refiner LoRA",
        name: refinerLora ?? OPENJUTSU_REFINER_LORAS.join(" or "),
        found: lora?.ok ? Boolean(refinerLora) : undefined,
      },
    ];
  }

  const missingList = !unet.ok || !clip.ok || (openjutsu && (!lora?.ok || !upscaler?.ok));
  return NextResponse.json({
    target,
    kind,
    host,
    checked: true,
    unet: { name: unetName, found: unet.ok ? unet.options.includes(unetName) : undefined },
    clip: { name: clipName, found: clip.ok ? clip.options.includes(clipName) : undefined },
    ...(files ? { files } : {}),
    ...(refinerLora ? { refinerLora } : {}),
    note: missingList ? "Some loader lists were unavailable; the rest were checked." : undefined,
  });
}
