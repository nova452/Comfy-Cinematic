import { NextResponse } from "next/server";
import { activeEndpoint, envLocalKey, envRouterKey, readAccount } from "../../../../lib/account";
import { readLocalConfig } from "../../../../lib/local-config";
import { loaderLists, type LoaderList } from "../../../../lib/model-lists";

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

  // Check what the dialog is showing, not what was last saved.
  let body: { unet?: unknown; clip?: unknown } = {};
  try {
    body = (await request.json()) as { unet?: unknown; clip?: unknown };
  } catch {
    // No body: fall back to the saved configuration.
  }

  const saved = await readLocalConfig(request);
  const unetName = typeof body.unet === "string" && body.unet.trim() ? body.unet.trim() : saved.unet;
  const clipName = typeof body.clip === "string" && body.clip.trim() ? body.clip.trim() : saved.clip;

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

  let unet: LoaderList;
  let clip: LoaderList;
  try {
    ({ unet, clip } = await loaderLists(target, key));
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

  return NextResponse.json({
    target,
    kind,
    host,
    checked: true,
    unet: { name: unetName, found: unet.ok ? unet.options.includes(unetName) : undefined },
    clip: { name: clipName, found: clip.ok ? clip.options.includes(clipName) : undefined },
    note: unet.ok && clip.ok ? undefined : "One loader list was unavailable; the other was checked.",
  });
}
