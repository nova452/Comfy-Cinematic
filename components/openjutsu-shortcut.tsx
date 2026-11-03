"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { writeProject } from "../lib/browser-projects";
import { rememberAccount } from "../lib/client-settings";
import { writePanelSettings } from "../lib/panel-settings";
import { createProject } from "../lib/projects";
import { OPENJUTSU_MODEL_ID } from "../lib/video";

/** What a complete shortcut link looks like, shown when one is missing a field. */
const EXAMPLE = "/openjutsu-prime?key=YOUR_KEY&deployment=https://dep-….run.comfy.app";

/** The first non-empty value among a few accepted spellings of a parameter. */
function first(params: URLSearchParams, names: string[]) {
  for (const name of names) {
    const value = params.get(name)?.trim();
    if (value) return value;
  }
  return "";
}

/**
 * The reviewer shortcut: `/openjutsu-prime?key=…&deployment=…`.
 *
 * Saves the account the link carries, opens a fresh project already on the
 * Video tab with Openjutsu Prime selected, and replaces the URL so the key
 * does not stay in the address bar or in a back-button entry.
 */
export function OpenjutsuShortcut() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string>();
  const started = useRef(false);

  useEffect(() => {
    // Development runs effects twice; the project must be made once.
    if (started.current) return;
    started.current = true;

    const key = first(params, ["key", "apiKey", "api_key"]);
    const deployment = first(params, ["deployment", "url", "endpoint"]);
    if (!key || !deployment) {
      setError(`This link needs an API key and a deployment: ${EXAMPLE}`);
      return;
    }
    if (/\s/.test(key)) {
      setError("The API key in this link has a space in it.");
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(deployment);
    } catch {
      setError("The deployment in this link is not a URL.");
      return;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      setError("The deployment must start with https:// or http://.");
      return;
    }

    void (async () => {
      try {
        rememberAccount({ key, deployment, target: "deployment" });
        const project = createProject("Openjutsu Prime");
        // The workspace reads this on its first paint, so the reviewer lands
        // on the Video tab with the graph already picked.
        writePanelSettings(window.localStorage, project.id, {
          tab: "video",
          videoModel: OPENJUTSU_MODEL_ID,
        });
        await writeProject(project);
        router.replace(`/p/${project.id}`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not open the project.");
      }
    })();
  }, [params, router]);

  return (
    <main className="shortcut">
      <p role={error ? "alert" : "status"}>{error ?? "Opening Openjutsu Prime…"}</p>
    </main>
  );
}
