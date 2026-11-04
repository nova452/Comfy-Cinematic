/**
 * Whether a request is the host's own: made on this machine, by this app.
 *
 * The gifting routes (minting links, picking up requests) belong to whoever
 * runs this copy. They are refused for anything that came through a proxy or
 * tunnel, for a host name that is not loopback (which also defeats DNS
 * rebinding), and for a cross-site page in the host's own browser.
 */

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Headers only a proxy or tunnel adds, whatever their value. */
const PROXY_ONLY = ["cf-connecting-ip", "cf-ray", "true-client-ip", "forwarded"];

function loopbackAddress(value: string) {
  const address = value.trim().replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "").toLowerCase();
  return address === "::1" || address === "localhost" || /^127(\.\d{1,3}){3}$/.test(address);
}

function hostName(host: string) {
  return host.trim().replace(/:\d+$/, "").toLowerCase();
}

export function isOwnerRequest(request: Request) {
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (!LOOPBACK_NAMES.has(hostName(host))) return false;
  if (PROXY_ONLY.some((name) => request.headers.has(name))) return false;

  // Next fills these in from the socket when a client did not send them, so
  // their presence proves nothing; every hop they name must be this machine.
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor && !forwardedFor.split(",").every(loopbackAddress)) return false;
  const realIp = request.headers.get("x-real-ip");
  if (realIp && !loopbackAddress(realIp)) return false;
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost && !LOOPBACK_NAMES.has(hostName(forwardedHost))) return false;

  // Another site open in the same browser could still post to localhost.
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== host.toLowerCase()) return false;
    } catch {
      return false;
    }
  }
  return true;
}
