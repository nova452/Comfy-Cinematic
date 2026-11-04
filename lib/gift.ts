/**
 * One-time gift links for Openjutsu Prime.
 *
 * A gift is a friend's single free clip, rendered in the gifter's own browser
 * on the gifter's account: `light` on 480P for 5 seconds. The link carries a
 * random token for the gifter's relay, never a Comfy key. This module is
 * shared with the browser, so it holds constants only — the relay lives in
 * `gift-relay.ts`, the friend's side in `gift-client.ts`.
 */

import { OPENJUTSU_MODEL_ID } from "./video.ts";

/** What one gift buys, whatever the panel or request body says. */
export const GIFT_LIMITS = {
  model: OPENJUTSU_MODEL_ID,
  mode: "video",
  openjutsuMode: "light",
  resolution: "480P",
  duration: 5,
  /**
   * Requests one link may make. A failed render gives the link back, so this
   * is what bounds the gifter's spend.
   */
  attempts: 3,
} as const;

/** What a friend reads when the gifter's tab is not open. */
export const HOST_OFF_MESSAGE = "Gifter host is off, try another time.";

/**
 * What a friend reads when the gifter's render fails, whatever the reason.
 * The reason itself (a missing model file, an empty deployment setting) is
 * about the gifter's machine: their own tab shows it, the friend's never does.
 */
export const GIFT_FAILED_MESSAGE = "The gifter's render didn't go through.";
