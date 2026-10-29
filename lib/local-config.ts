/**
 * The local H3 model configuration, as edited from the model picker's gear.
 *
 * Saved in the browser and sent with each request, like the account, so every
 * visitor names the files on their own ComfyUI.
 */

import { localModelConfig, LOCAL_MODEL_DEFAULTS, type LocalModelConfig } from "./video.ts";
import { requestSettings } from "./studio-settings.ts";

/** The browser's values win; `H3_CLIP` / `H3_STEPS` fill gaps. */
export async function readLocalConfig(
  source?: Request | Headers,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalModelConfig> {
  const steps = Number.parseInt(env.H3_STEPS ?? "", 10);
  const fromEnv = {
    clip: env.H3_CLIP?.trim() || undefined,
    steps: Number.isFinite(steps) && steps > 0 ? steps : undefined,
  };
  return localModelConfig({ ...fromEnv, ...(requestSettings(source).localModel ?? {}) });
}

export { LOCAL_MODEL_DEFAULTS };
