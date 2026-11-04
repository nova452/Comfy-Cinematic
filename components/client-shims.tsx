"use client";

// Stand-ins for browser features a plain-http network address lacks
// (lib/uuid-shim.ts). Imported here so they load with every page.
import "../lib/uuid-shim";

export function ClientShims() {
  return null;
}
