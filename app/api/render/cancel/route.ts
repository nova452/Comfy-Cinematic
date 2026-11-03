import { NextResponse } from "next/server";
import { cancelRender, isRenderId } from "../../../../lib/render-progress";

export const runtime = "nodejs";

/**
 * Stop a render in flight, by the id of the tile that is waiting for it.
 *
 * The render's own request then answers `Cancelled.`; this only pulls the
 * trigger. 404 means this server is not running that render (it finished, or
 * the server restarted), so the tile can simply be dropped.
 */
export async function POST(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!isRenderId(id)) return NextResponse.json({ error: "Name a render id." }, { status: 400 });
  return cancelRender(id)
    ? NextResponse.json({ cancelled: true })
    : NextResponse.json({ error: "No render in flight with that id." }, { status: 404 });
}
