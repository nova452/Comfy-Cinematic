/**
 * The local video configurations, as edited from each model picker's gear.
 *
 * MiniMax H3 Local and Openjutsu are separate rows in the picker, so they keep
 * separate settings: a render reads the record for the graph it is about to
 * run. Both are saved in the browser and sent with each request, like the
 * account, so every visitor names the files on their own ComfyUI.
 */

import { localModelConfig, LOCAL_MODEL_DEFAULTS, type LocalModelConfig } from "./video.ts";
import { requestSettings } from "./studio-settings.ts";

/** The browser's values win; `H3_CLIP` / `H3_STEPS` fill gaps. */
async function readConfig(record: unknown, env: NodeJS.ProcessEnv): Promise<LocalModelConfig> {
  const steps = Number.parseInt(env.H3_STEPS ?? "", 10);
  const fromEnv = {
    clip: env.H3_CLIP?.trim() || undefined,
    steps: Number.isFinite(steps) && steps > 0 ? steps : undefined,
  };
  return localModelConfig({ ...fromEnv, ...(record as Record<string, unknown> | undefined) });
}

/** MiniMax H3 Local's own settings (the plain H3 stack). */
export async function readLocalConfig(
  source?: Request | Headers,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalModelConfig> {
  return readConfig(requestSettings(source).localModel, env);
}

/**
 * Openjutsu's own settings (the ref5 graph).
 *
 * Before the two local rows had separate gears this lived in `localModel`; a
 * browser that has not saved an Openjutsu configuration yet still reads that
 * record, so its key and checkpoint names survive the split.
 */
export async function readOpenjutsuConfig(
  source?: Request | Headers,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalModelConfig> {
  const settings = requestSettings(source);
  return readConfig(settings.openjutsu ?? settings.localModel, env);
}

export { LOCAL_MODEL_DEFAULTS };
