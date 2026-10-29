import type { NextConfig } from "next";

/**
 * A public deployment keeps each visitor's Comfy key in their own browser, so
 * the page itself is the only thing worth locking down: a script from anywhere
 * but this origin could read that key out of `localStorage`.
 *
 * `unsafe-inline` stays for styles and scripts because Next inlines both, and
 * `unsafe-eval` is added in development only, where React and the dev server
 * need it. The win is that no third-party origin may load a script at all.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  // The sample clips are hosted on GitHub, not bundled with the app.
  "media-src 'self' data: blob: https://raw.githubusercontent.com",
  "connect-src 'self' https://raw.githubusercontent.com",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  devIndicators: false,
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
