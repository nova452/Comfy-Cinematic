"use client";

import { useEffect, useState } from "react";

/** The element that actually scrolls `node`, so the margin applies inside it. */
function scrollParent(node: Element): Element | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll") return parent;
  }
  return null;
}

/**
 * Whether an element is on screen or close to it, inside whatever panel
 * scrolls it.
 *
 * With `once` the answer latches at true — a tile that has loaded its media
 * keeps it. Without it the flag follows the element in and out, which is what
 * a "load more" sentinel needs.
 *
 * Returns a callback ref rather than a ref object, so an element that mounts
 * late (a sentinel shown only while there is more to show) is still observed.
 */
export function useNearViewport<T extends Element>({ once = true, margin = "400px" } = {}) {
  const [node, setNode] = useState<T | null>(null);
  const [near, setNear] = useState(false);
  const settled = once && near;

  useEffect(() => {
    if (!node || settled) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries[entries.length - 1]!.isIntersecting;
        if (once && !hit) return;
        setNear(hit);
      },
      { root: scrollParent(node), rootMargin: margin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, settled, once, margin]);

  return [setNode, near] as const;
}
