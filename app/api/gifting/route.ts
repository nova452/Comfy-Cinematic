import { NextResponse } from "next/server";
import { giftingStatus, startRelay, stopRelay } from "../../../lib/gift-relay";
import { isOwnerRequest } from "../../../lib/local-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_OWNER = { error: "Gifting is managed from the host's own copy of the app." };

/** Whether this copy is gifting, its relay address and its links. */
export async function GET(request: Request) {
  if (!isOwnerRequest(request)) return NextResponse.json(NOT_OWNER, { status: 403 });
  return NextResponse.json(await giftingStatus(), { headers: { "cache-control": "no-store" } });
}

/** `{ "action": "enable" }` starts the relay; `"disable"` stops it. Links are kept either way. */
export async function POST(request: Request) {
  if (!isOwnerRequest(request)) return NextResponse.json(NOT_OWNER, { status: 403 });
  let body: { action?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Send a JSON request." }, { status: 400 });
  }

  try {
    if (body.action === "enable") await startRelay();
    else if (body.action === "disable") await stopRelay();
    else return NextResponse.json({ error: 'Send {"action":"enable"} or {"action":"disable"}.' }, { status: 400 });
  } catch (error) {
    console.error("[gifting] relay start/stop failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The gift relay could not start." },
      { status: 500 },
    );
  }
  return NextResponse.json(await giftingStatus(), { headers: { "cache-control": "no-store" } });
}
