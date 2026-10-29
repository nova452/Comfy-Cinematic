/**
 * Payload validation for the media a render can be handed.
 *
 * These are linear scans on purpose. The first version used anchored regexes
 * over the whole string, and V8 answered a few megabytes of base64 with
 * `RangeError: Maximum call stack size exceeded` — exactly the size a real clip
 * reference has — so a Video Reference render died with an opaque 500 before
 * anything ran. A character loop has no such ceiling.
 */

/** Audio and video references are allowed to be bigger than a still. */
export const MAX_MEDIA_MB = 50;

/** The same ceiling in base64 characters: four chars per three bytes, rounded up. */
export const MAX_MEDIA_CHARS = Math.ceil((MAX_MEDIA_MB * 1024 * 1024 * 4) / 3);

/** A prepared reference still. */
export const MAX_REFERENCE_CHARS = 3_000_000;

/** Base64 shaped, checked by walking the payload. */
export function isBase64Payload(value: string) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const end = value.length - padding;
  if (end <= 0) return false;

  for (let index = 0; index < end; index += 1) {
    const code = value.charCodeAt(index);
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const digit = code >= 48 && code <= 57;
    // `+` and `/` complete the alphabet.
    if (!letter && !digit && code !== 43 && code !== 47) return false;
  }
  return true;
}

/** A bare base64 value — a still's payload, with no data-URI prefix. */
export function isBase64Value(value: string, max: number) {
  return value.length >= 64 && value.length <= max && isBase64Payload(value);
}

/**
 * `data:video/mp4;base64,…`, of the expected kind and within the size cap.
 *
 * Only the first few dozen characters are matched; the megabyte tail is walked.
 */
export function isMediaUri(value: string, kind: "audio" | "video", max = MAX_MEDIA_CHARS) {
  const head = /^data:([a-z]+)\/[a-z0-9.+-]+;base64,/i.exec(value.slice(0, 64));
  if (!head || head[1]!.toLowerCase() !== kind) return false;
  if (value.length > max) return false;
  return isBase64Payload(value.slice(head[0].length));
}
