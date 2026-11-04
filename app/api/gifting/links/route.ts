import { NextResponse } from "next/server";
import { giftLinkUrl, giftRelay, giftingStatus, startRelay, stopIfIdle } from "../../../../lib/gift-relay";
import { isOwnerRequest } from "../../../../lib/local-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_OWNER = { error: "Gifting is managed from the host's own copy of the app." };

/**
 * Mint a one-time link, valid for 24 hours. Minting turns gifting on. The link
 * is in this answer once: only the token's hash is kept.
 */
export async function POST(request: Request) {
  if (!isOwnerRequest(request)) return NextResponse.json(NOT_OWNER, { status: 403 });
  try {
    const state = await startRelay();
    const { link, token } = await state.relay.createLink();
    return NextResponse.json(
      { id: link.id, expiresAt: link.expiresAt, url: giftLinkUrl(token) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("[gifting] mint failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The link could not be made." },
      { status: 500 },
    );
  }
}

/** Revoke a link by id. With nothing left to serve, gifting turns itself off. */
export async function DELETE(request: Request) {
  if (!isOwnerRequest(request)) return NextResponse.json(NOT_OWNER, { status: 403 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Name a link id." }, { status: 400 });
  const revoked = await giftRelay().relay.revokeLink(id);
  if (!revoked) return NextResponse.json({ error: "No link with that id." }, { status: 404 });
  await stopIfIdle();
  return NextResponse.json(await giftingStatus(), { headers: { "cache-control": "no-store" } });
}
