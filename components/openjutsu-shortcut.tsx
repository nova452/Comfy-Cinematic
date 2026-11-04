"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { writeProject } from "../lib/browser-projects";
import { rememberAccount } from "../lib/client-settings";
import { GIFT_LIMITS } from "../lib/gift";
import { giftFromFragment, projectForGift, writeProjectGift } from "../lib/gift-client";
import { readPanelSettings, writePanelSettings } from "../lib/panel-settings";
import { createProject } from "../lib/projects";
import { OPENJUTSU_MODEL_ID } from "../lib/video";
import { ProjectWorkspace } from "./project-workspace";

/** Whether a link's key and deployment are both there and fit to keep. */
function usableAccount(key: string, deployment: string) {
  if (!key || !deployment || /\s/.test(key)) return false;
  try {
    const { protocol } = new URL(deployment);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** The first non-empty value among a few accepted spellings of a parameter. */
function first(params: URLSearchParams, names: string[]) {
  for (const name of names) {
    const value = params.get(name)?.trim();
    if (value) return value;
  }
  return "";
}

/**
 * The reviewer shortcut:
 *
 * - `?key=…&deployment=…` keeps the account the link carries.
 * - Anything else, including no query at all or a half-filled one, opens the
 *   project with the browser's own account.
 * - `#gift=…&host=…` is a friend's gift link: one clip, rendered on the
 *   gifter's machine through their relay. The fragment never reaches any
 *   server; the project keeps the token and sends its request to the relay.
 *   Opening the same link again goes back to the project it made.
 *
 * Both open a fresh project on the Video tab with Openjutsu Prime selected,
 * right here: the workspace renders in place and the address becomes the
 * project's own `/p/<id>`, so there is no page in between.
 * The query string and fragment leave the address bar and history as soon as they have been
 * read, whether the link then works or not.
 */
export function OpenjutsuShortcut() {
  const params = useSearchParams();
  const [error, setError] = useState<string>();
  const [projectId, setProjectId] = useState<string>();
  const started = useRef(false);

  useEffect(() => {
    // Development runs effects twice; the project must be made once.
    if (started.current) return;
    started.current = true;

    const key = first(params, ["key", "apiKey", "api_key"]);
    const deployment = first(params, ["deployment", "url", "endpoint"]);
    const friendGift = giftFromFragment(window.location.hash);
    window.history.replaceState(null, "", window.location.pathname);

    // The project's own address, without a navigation: a reload lands on the
    // project page itself.
    function show(id: string) {
      window.history.replaceState(null, "", `/p/${id}`);
      setProjectId(id);
    }

    async function openProject(gifted: boolean, onCreate?: (projectId: string) => void) {
      const project = createProject("Openjutsu Prime");
      onCreate?.(project.id);
      // The workspace reads this on its first paint, so the reviewer lands on
      // the Video tab with the graph already picked. A gift is pinned to its
      // 480P/5s budget as well.
      writePanelSettings(window.localStorage, project.id, {
        tab: "video",
        videoModel: OPENJUTSU_MODEL_ID,
        ...(gifted
          ? { videoResolution: GIFT_LIMITS.resolution, videoDuration: GIFT_LIMITS.duration }
          : {}),
      });
      // The workspace reads the project from the store as it mounts.
      await writeProject(project);
      show(project.id);
    }

    if (friendGift) {
      void (async () => {
        try {
          const known = projectForGift(friendGift.token);
          if (known) {
            // Whatever tab the project was left on, the link opens it where a
            // gift is spent: the Video tab, on Openjutsu Prime.
            writePanelSettings(window.localStorage, known, {
              ...readPanelSettings(window.localStorage, known),
              tab: "video",
              videoModel: OPENJUTSU_MODEL_ID,
            });
            show(known);
            return;
          }
          // The project opens at once and checks the link with the gifter's
          // relay itself, so a visitor is in the app while it does.
          await openProject(true, (projectId) => writeProjectGift(projectId, friendGift));
        } catch {
          setError("Could not open Openjutsu Prime. Try reloading the page.");
        }
      })();
      return;
    }

    // A link's account is kept only when it is whole and well formed. Anything
    // else still opens the project: renders use whatever account the browser
    // already keeps, and a visitor never reads about query strings.
    void (async () => {
      try {
        if (usableAccount(key, deployment)) rememberAccount({ key, deployment, target: "deployment" });
        await openProject(false);
      } catch {
        setError("Could not open Openjutsu Prime. Try reloading the page.");
      }
    })();
  }, [params]);

  if (projectId) return <ProjectWorkspace projectId={projectId} />;
  // The project is stored in a few milliseconds; until then there is nothing
  // to say, so nothing is shown.
  if (!error) return null;
  return (
    <main className="shortcut">
      <p role="alert">{error}</p>
    </main>
  );
}
