/**
 * Router returns each partner's native result document, and the asset leaf
 * differs per model. Every model this app uses (FLUX 3 image and FLUX 3 video)
 * answers with a signed `result.sample` URL, so one reader covers both.
 */
export function fluxAssetUrl(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return;
  const result = Reflect.get(data, "result");
  const sample = result && typeof result === "object" ? Reflect.get(result, "sample") : undefined;
  if (typeof sample !== "string") return;
  try {
    const url = new URL(sample);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
