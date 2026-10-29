import { comfy } from "@comfyorg/sdk";

type Run = typeof comfy.models.run;

/**
 * `comfy.models.run` with this request's key.
 *
 * The SDK's `comfy` namespace holds one process-wide credential, and `run`
 * reads it synchronously before its first await. Setting it and starting the
 * call in the same tick pins the key to this call, so two visitors rendering at
 * once can never swap keys — which `config()` followed by awaits would allow.
 */
export function runModel(apiKey: string | undefined, ...args: Parameters<Run>): ReturnType<Run> {
  if (!apiKey) return Promise.reject(new Error("Sign in with a Comfy Router API key first.")) as ReturnType<Run>;
  comfy.config({ credentials: apiKey });
  try {
    return comfy.models.run(...args);
  } finally {
    // Never leave a visitor's key behind for the next caller to inherit.
    comfy.config({ credentials: undefined });
  }
}
