/**
 * The company mark that sits next to a model's name, the way OpenRouter
 * badges its model rows.
 *
 * Both marks follow the label's text colour rather than carrying a colour of
 * their own, and neither ships a background tile:
 *
 * - MiniMax: the waveform mark from minimaxi.com's favicon (fetched through
 *   Google's faviconV2, the service OpenRouter uses), keyed off its gradient
 *   tile to leave the mark alone. Vendored as `public/logos/minimax-mark.png`
 *   so a render never waits on that CDN, then painted through that alpha as a
 *   CSS mask so it can inherit `currentColor`.
 * - Black Forest Labs: the symbol from bfl.ai's `symbol-white.svg`, inlined
 *   with `currentColor` in place of its hard-coded white.
 */
export type ModelBrand = "minimax" | "bfl";

/** bfl.ai `symbol-white.svg` — the mark on its own, no backing rect. */
const BFL_MARK =
  "M140.651 59.8389H119.806L98.9601 30.4717L33.9327 121.982H54.8224L98.9591 59.8408H119.805L75.6681 121.982H96.6163L140.651 59.8389L196.895 139.025H181.162V139.026H163.987V122.049L140.651 89.2061L117.445 121.986V139.025H63.5626L63.5616 139.027H42.7159L42.7169 139.025H0.894653L98.9601 0.973633L140.651 59.8389Z";

const BRAND_NAMES: Record<ModelBrand, string> = {
  minimax: "MiniMax",
  bfl: "Black Forest Labs",
};

export function ModelLogo({ brand }: { brand: ModelBrand }) {
  return (
    <span className="model-logo" data-brand={brand} title={BRAND_NAMES[brand]} aria-hidden="true">
      {brand === "minimax" ? (
        // A mask, not an <img>: the PNG only supplies the alpha, so the glyph
        // is drawn in whatever colour the surrounding text is.
        <span className="model-logo-mask" />
      ) : (
        <svg viewBox="0 0 197 140" width="16" height="16" focusable="false">
          <path d={BFL_MARK} fill="currentColor" />
        </svg>
      )}
    </span>
  );
}
