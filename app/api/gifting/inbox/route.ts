import { NextResponse } from "next/server";
import { activeEndpoint, readAccount } from "../../../../lib/account";
import { decodeDataUri, giftRelay, stopIfIdle } from "../../../../lib/gift-relay";
import { isOwnerRequest } from "../../../../lib/local-request";
import { isRenderId } from "../../../../lib/render-progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_OWNER = { error: "Gifting is managed from the host's own copy of the app." };

/** Which of the gifter's tabs this is, for the console: its address and browser. */
function tabName(request: Request) {
  const agent = request.headers.get("user-agent") ?? "";
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /OPR\//.test(agent)
      ? "Opera"
      : /Firefox\//.test(agent)
        ? "Firefox"
        : /Chrome\//.test(agent)
          ? "Chrome"
          : /Safari\//.test(agent)
            ? "Safari"
            : "a browser";
  return `${browser} at ${request.headers.get("host") ?? "?"}`;
}

function sessionOf(value: unknown) {
  return typeof value === "string" && isRenderId(value) ? value : undefined;
}

/**
 * The host tab checks in every few seconds: that is what keeps it "online"
 * for friends. When it is free, the answer carries the next gift to render.
 */
export async function GET(request: Request) {
  if (!isOwnerRequest(request)) return NextResponse.json(NOT_OWNER, { status: 403 });
  const session = sessionOf(new URL(request.url).searchParams.get("session"));
  if (!session) return NextResponse.json({ error: "Name a session id." }, { status: 400 });

  const state = giftRelay();
  if (!state.server) return NextResponse.json({ enabled: false }, { headers: { "cache-control": "no-store" } });
  if (await stopIfIdle()) return NextResponse.json({ enabled: false }, { headers: { "cache-control": "no-store" } });

  // Only a tab that can render takes gifts. Each address keeps its own
  // settings, so a tab on another one (127.0.0.1 next to localhost) may have
  // no render target at all: it would fail every gift it picked up, so it does
  // not check in and does not count as the host being there.
  if (!activeEndpoint(await readAccount(request))) {
    return NextResponse.json({ enabled: true }, { headers: { "cache-control": "no-store" } });
  }

  const job = await state.relay.checkIn(session);
  // Several tabs (or browsers) of the gifter's may be open; the console says
  // which one took a gift, so a failure that shows nowhere can be traced.
  if (job) console.info(`[gift] request ${job.id.slice(0, 8)} taken by ${tabName(request)}`);
  return NextResponse.json({ enabled: true, ...(job ? { job } : {}) }, { headers: { "cache-control": "no-store" } });
}

/**
 * How a gift the tab took went:
 * `{ jobId, session, action: "started", renderId }`,
 * `{ jobId, session, action: "failed", error }`, or
 * `{ jobId, session, action: "done", video: "data:video/mp4;base64,…" }`.
 */
export async function POST(request: Request) {
  if (!isOwnerRequest(request)) return NextResponse.json(NOT_OWNER, { status: 403 });
  let body: { jobId?: unknown; session?: unknown; action?: unknown; renderId?: unknown; error?: unknown; video?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Send a JSON request." }, { status: 400 });
  }
  const session = sessionOf(body.session);
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  if (!session || !/^[0-9a-f-]{36}$/i.test(jobId)) {
    return NextResponse.json({ error: "Name the gift and the session." }, { status: 400 });
  }

  const { relay } = giftRelay();
  let ok = false;
  if (body.action === "started" && typeof body.renderId === "string" && isRenderId(body.renderId)) {
    ok = await relay.started(jobId, session, body.renderId);
  } else if (body.action === "failed") {
    const reason = typeof body.error === "string" ? body.error : "The render failed.";
    console.warn(`[gift] request ${jobId.slice(0, 8)} failed in ${tabName(request)}: ${reason}`);
    ok = await relay.failed(jobId, session, reason);
  } else if (body.action === "done" && typeof body.video === "string") {
    const clip = decodeDataUri(body.video);
    if (!clip || !clip.type.startsWith("video/")) {
      return NextResponse.json({ error: "Send the clip as a video data URI." }, { status: 400 });
    }
    ok = await relay.finished(jobId, session, clip.bytes, clip.type);
  } else {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  if (!ok) return NextResponse.json({ error: "That gift is not this tab's to report." }, { status: 409 });
  await stopIfIdle();
  return NextResponse.json({ ok: true });
}
