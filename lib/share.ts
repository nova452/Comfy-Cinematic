/**
 * Everything the Share sheet needs to build a post, a link and an embed.
 *
 * Deliberately free of React and of `window` so `node:test` can import it and
 * so the copy lives in one place instead of in the dialog's JSX.
 */

/** Where the source lives. */
export const GITHUB_REPO = {
  name: "Comfy-Org/comfy-cinematic-studio",
  url: "https://github.com/Comfy-Org/comfy-cinematic-studio",
} as const;

export const SITE_NAME = "Comfy Cinematic";

/**
 * X counts every link as 23 characters no matter how long it is, so the text
 * that travels next to one has this much room before the composer truncates it.
 */
export const X_TEXT_LIMIT = 280 - 23;

/** A project with no name yet still needs something to call itself. */
export function displayName(name: string) {
  const trimmed = name.trim();
  return trimmed || "Untitled project";
}

/** The post body: the project, what it holds, and the stack behind it. */
export function shareText(name: string, count: number) {
  const items =
    count === 0 ? "an empty canvas" : count === 1 ? "one frame" : `${count} frames`;
  const text = `“${displayName(name)}” · ${items} in ${SITE_NAME}. Built on Comfy Router.`;
  return text.length <= X_TEXT_LIMIT ? text : `${text.slice(0, X_TEXT_LIMIT - 1).trimEnd()}…`;
}

/** X's web composer, pre-filled and usable signed out. */
export function xShareUrl(text: string, url: string) {
  const params = new URLSearchParams({ text, url });
  return `https://x.com/intent/post?${params.toString()}`;
}

/** The host people will see on the preview card, e.g. `127.0.0.1:3000`. */
export function hostOf(url: string) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
