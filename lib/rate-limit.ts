/**
 * A small per-client request budget for the routes a stranger can hit with
 * guesses: the gift relay's public routes.
 *
 * Kept in this process's memory, which is all the relay needs. The point is
 * to turn token guessing and request spam into a trickle, not to be an exact
 * meter.
 */

type Window = { count: number; resetAt: number };

const shared = globalThis as typeof globalThis & { __rateWindows?: Map<string, Window> };
const windows = (shared.__rateWindows ??= new Map());

/**
 * The calling client's address, as the host's proxy reports it. Cloudflare's
 * own header comes first: a client can put anything at the front of
 * `x-forwarded-for`, but not in `cf-connecting-ip`.
 */
export function clientAddress(request: Request) {
  const cloudflare = request.headers.get("cf-connecting-ip")?.trim();
  if (cloudflare) return cloudflare;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Count one request against `bucket` for this client. The answer is the
 * seconds to wait when the budget is spent, or 0 when the request may go on.
 */
export function rateLimited(
  request: Request,
  bucket: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
) {
  const key = `${bucket}:${clientAddress(request)}`;
  let window = windows.get(key);
  if (!window || window.resetAt <= now) {
    // Drop spent windows now and then, so the map cannot grow without bound.
    if (windows.size > 10_000) {
      for (const [name, entry] of windows) if (entry.resetAt <= now) windows.delete(name);
    }
    window = { count: 0, resetAt: now + windowMs };
    windows.set(key, window);
  }
  window.count += 1;
  return window.count > limit ? Math.max(1, Math.ceil((window.resetAt - now) / 1000)) : 0;
}

/** Forget every window; tests use it between cases. */
export function resetRateLimits() {
  windows.clear();
}
