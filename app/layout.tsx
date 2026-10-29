import type { Metadata } from "next";
import { Anton, Space_Grotesk } from "next/font/google";
import "./globals.css";

const display = Anton({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display",
  display: "swap",
});

const ui = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ui",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Comfy Cinematic",
  description:
    "A project canvas for Comfy Router. Describe a frame and it lands on the canvas; ask a question and the harness answers. FLUX 3 stills up to 4K and MiniMax H3 clips.",
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
      <body>{children}</body>
    </html>
  );
}
