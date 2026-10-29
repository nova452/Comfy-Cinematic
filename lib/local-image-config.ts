/**
 * The local FLUX 3 model configuration, as edited from the image picker's gear.
 *
 * Saved in the browser and sent with each request, like the account, so every
 * visitor names the files on their own ComfyUI.
 */

import { localImageModelConfig, LOCAL_IMAGE_DEFAULTS, type LocalImageModelConfig } from "./harness.ts";
import { requestSettings } from "./studio-settings.ts";

/** The browser's values win; `FLUX_UNET` / `FLUX_CLIP` / `FLUX_STEPS` fill gaps. */
export async function readLocalImageConfig(
  source?: Request | Headers,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalImageModelConfig> {
  const steps = Number.parseInt(env.FLUX_STEPS ?? "", 10);
  const fromEnv = {
    unet: env.FLUX_UNET?.trim() || undefined,
    clip: env.FLUX_CLIP?.trim() || undefined,
    steps: Number.isFinite(steps) && steps > 0 ? steps : undefined,
  };
  return localImageModelConfig({ ...fromEnv, ...(requestSettings(source).localImage ?? {}) });
}

export { LOCAL_IMAGE_DEFAULTS };
