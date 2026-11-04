import type { Metadata } from "next";
import localFont from "next/font/local";
import { ClientShims } from "../components/client-shims";
import { GiftHost } from "../components/gift-host";
import "./globals.css";

/**
 * Both faces are self-hosted, not fetched by `next/font/google`.
 *
 * Google answers a `css2` request with an extensionless
 * `fonts.gstatic.com/l/font?kit=…&skey=…&v=…` URL about one time in sixty.
 * Turbopack parses the font's own options as a query string, the `&` splits it,
 * and the build dies with "next/font/google queries have exactly one entry"
 * (vercel/next.js#99114, fixed only in 16.5 canaries). Keeping the files beside
 * this one makes a build depend on this repository and nothing else — and the
 * bytes are Google's own latin subsets, so the CSS variables do not change.
 */
const display = localFont({
  src: "./fonts/anton-latin.woff2",
  weight: "400",
  variable: "--font-display",
  display: "swap",
});

const ui = localFont({
  // A variable file: one file covers every weight the panel asks for.
  src: "./fonts/space-grotesk-latin.woff2",
  weight: "300 700",
  variable: "--font-ui",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Comfy Cinematic",
  description:
    "Project canvases for FLUX 3 stills and MiniMax H3 clips on Comfy Router.",
  openGraph: {
    title: "Comfy Cinematic",
    description: "Project canvases with FLUX 3 stills and MiniMax H3 clips, built on Comfy Router.",
    type: "website",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // Browser extensions (CrossPilot, Grammarly, Loom, …) stamp attributes onto
    // `<html>` before React hydrates, which React reports as a mismatch it will
    // not patch. Silencing it here only covers this element's own attributes;
    // real mismatches inside the tree still surface.
    <html lang="en" className={`${display.variable} ${ui.variable}`} suppressHydrationWarning>
      <body>
        <ClientShims />
        {children}
        <GiftHost />
      </body>
    </html>
  );
}
