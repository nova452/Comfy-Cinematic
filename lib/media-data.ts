/**
 * A render handed back to the browser as a data URL.
 *
 * The server no longer writes media to disk: a route answers with the bytes
 * inline, the page stores them in IndexedDB and keeps a `media:` source. One
 * transfer, and nothing for the host to keep or clean up.
 */
export function dataUrl(bytes: Uint8Array, contentType: string) {
  const type = contentType.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}
