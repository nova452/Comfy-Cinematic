import { NextResponse } from "next/server";
import { clearProgress, isRenderId, takeOutcome } from "../../../../lib/render-progress";

export const runtime = "nodejs";

/**
 * Collect a finished render's answer by its tile id, once.
 *
 * This is for a page that reloaded while its clip rendered: the original
 * request answered into the void, and the server kept that answer here. The
 * body is exactly what `POST /api/video` returned. 404 means there is nothing
 * to collect — never finished, already collected, or lost to a restart.
 */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!isRenderId(id)) return NextResponse.json({ error: "Name a render id." }, { status: 400 });

  const body = takeOutcome(id);
  if (body === undefined) return NextResponse.json({ error: "Nothing to collect for that render." }, { status: 404 });
  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}

/** A page that got its answer directly says so, and the kept copy is dropped. */
export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!isRenderId(id)) return NextResponse.json({ error: "Name a render id." }, { status: 400 });
  clearProgress(id);
  return new NextResponse(null, { status: 204 });
}
