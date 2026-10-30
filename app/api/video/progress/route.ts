import { NextResponse } from "next/server";
import { isRenderId, progressLabel, readProgress } from "../../../../lib/render-progress";

export const runtime = "nodejs";

/**
 * Where one in-flight render has got to, for its tile on the canvas.
 *
 * 404 means this server holds nothing for that id: the render has not started
 * its first stage yet, has already answered, or the server restarted under it.
 * The tile keeps its plain "Rendering" label then rather than treating it as a
 * failure — the render's own request is what reports success or failure.
 */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!isRenderId(id)) return NextResponse.json({ error: "Name a render id." }, { status: 400 });

  const progress = readProgress(id);
  if (!progress) return NextResponse.json({ error: "No progress for that render." }, { status: 404 });

  return NextResponse.json(
    { ...progress, label: progressLabel(progress), elapsed: Math.round((Date.now() - progress.startedAt) / 1000) },
    { headers: { "cache-control": "no-store" } },
  );
}
