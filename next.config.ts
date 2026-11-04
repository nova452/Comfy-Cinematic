import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

/**
 * A public deployment keeps each visitor's Comfy key in their own browser, so
 * the page itself is the only thing worth locking down: a script from anywhere
 * but this origin could read that key out of `localStorage`.
 *
 * `unsafe-inline` stays for styles and scripts because Next inlines both, and
 * `unsafe-eval` is added in development only, where React and the dev server
 * need it. The win is that no third-party origin may load a script at all.
 */
/**
 * Where a friend's page may send a gift request: a gifter's quick tunnel, a
 * relay on this machine, a fixed relay this deployment names, and litterbox,
 * where a finished gift clip also waits for 24 hours.
 */
function giftRelayOrigin() {
  try {
    return process.env.GIFT_RELAY_URL ? ` ${new URL(process.env.GIFT_RELAY_URL).origin}` : "";
  } catch {
    return "";
  }
}
const giftSources = `https://*.trycloudflare.com http://127.0.0.1:* http://localhost:* https://litter.catbox.moe${giftRelayOrigin()}`;

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  // The sample clips are hosted on GitHub, not bundled with the app.
  "media-src 'self' data: blob: https://raw.githubusercontent.com",
  `connect-src 'self' https://raw.githubusercontent.com ${giftSources}`,
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * This machine's own addresses. `npm run dev:lan` serves the app to other
 * devices on its network addresses, and the dev server only lets a page load
 * its dev-only assets from origins it is told about — loopback included, since
 * listening on every interface no longer implies it.
 */
const lanAddresses = Object.values(networkInterfaces())
  .flat()
  .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
  .map((entry) => entry!.address);

const nextConfig: NextConfig = {
  devIndicators: false,
  allowedDevOrigins: ["localhost", "127.0.0.1", ...lanAddresses],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
