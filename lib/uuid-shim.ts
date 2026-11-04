/**
 * `crypto.randomUUID` exists only in secure contexts (https, or localhost). On
 * a plain-http network address, as when a phone opens `npm run dev:lan`, it is
 * missing, and every new project, message and render id would throw. Random
 * bytes are available everywhere, so they stand in for it there.
 */
if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") {
  const randomUUID = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    // Version 4, RFC 4122 variant.
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  Object.defineProperty(crypto, "randomUUID", {
    value: randomUUID as Crypto["randomUUID"],
    configurable: true,
    writable: true,
  });
}

export {};
