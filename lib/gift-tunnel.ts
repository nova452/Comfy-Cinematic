/**
 * The tunnel that lets friends reach the gift relay.
 *
 * A Cloudflare quick tunnel (`cloudflared tunnel --url …`) needs no account:
 * it answers with a random `https://….trycloudflare.com` address that forwards
 * to the relay's port and nothing else. Only the relay is exposed; the app
 * itself stays on this machine. The address changes on every start, so links
 * minted before a restart stop working; `GIFT_RELAY_URL` names a fixed address
 * (a named tunnel) and switches this off.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

/** How long cloudflared gets to announce its address. */
const TUNNEL_START_MS = 45_000;

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** Where cloudflared lives: `CLOUDFLARED_PATH`, the installer's folders, or the PATH. */
export function cloudflaredPath(env = process.env) {
  const named = env.CLOUDFLARED_PATH?.trim();
  if (named) return named;
  if (process.platform === "win32") {
    const installed = [
      `${env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"}\\cloudflared\\cloudflared.exe`,
      `${env.ProgramFiles ?? "C:\\Program Files"}\\cloudflared\\cloudflared.exe`,
    ].find((path) => existsSync(path));
    if (installed) return installed;
  }
  return "cloudflared";
}

/** The first trycloudflare address in cloudflared's output, if any. */
export function tunnelUrlIn(text: string) {
  return text.match(TUNNEL_URL)?.[0];
}

export type Tunnel = { url: string; child: ChildProcess };

/**
 * Start a quick tunnel to `port` and wait for its address. `onExit` hears a
 * tunnel that dies later, so the relay stops handing out a dead address.
 */
export function startTunnel(port: number, onExit: () => void, env = process.env): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      cloudflaredPath(env),
      ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let settled = false;
    let output = "";
    const timer = setTimeout(() => fail(new Error("The tunnel did not start in time.")), TUNNEL_START_MS);

    function fail(error: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    }

    function read(chunk: Buffer) {
      if (settled) return;
      // Keep only the tail: cloudflared logs for as long as it runs.
      output = (output + chunk.toString()).slice(-4000);
      const url = tunnelUrlIn(output);
      if (!url) return;
      settled = true;
      clearTimeout(timer);
      resolve({ url, child });
    }

    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.once("error", (error: NodeJS.ErrnoException) =>
      fail(
        new Error(
          error.code === "ENOENT"
            ? "cloudflared is not installed, so friends cannot reach this machine."
            : `The tunnel could not start: ${error.message}`,
        ),
      ),
    );
    child.once("exit", (code) => {
      if (!settled) fail(new Error(`The tunnel stopped while starting (exit ${code ?? "?"}).`));
      else onExit();
    });
  });
}
