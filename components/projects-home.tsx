"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { deleteProject, listProjects, writeProject } from "../lib/browser-projects";
import { mediaUrl, useMediaVersion } from "../lib/browser-media";
import { createProject, relativeTime, type ProjectSummary } from "../lib/projects";
import { GITHUB_REPO } from "../lib/share";
import { AccountMenu } from "./account-menu";

// Placeholder footage for the home reel — swap the file, not the markup.
const HERO_REEL = "/media/hero-reel.mp4";

export function ProjectsHome() {
  const router = useRouter();
  // Tiles fill in as their thumbnails are read out of IndexedDB.
  useMediaVersion();
  const reelRef = useRef<HTMLVideoElement>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState<string>();

  const load = useCallback(async () => {
    try {
      setProjects(await listProjects());
      setError(undefined);
    } catch (cause) {
      setProjects([]);
      setError(cause instanceof Error ? cause.message : "Could not load projects.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The reel is decoration, so it stands down when the visitor asks for less motion.
  useEffect(() => {
    const video = reelRef.current;
    if (!video) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      if (query.matches) {
        video.pause();
        return;
      }
      // `muted` is a property, not always an attribute, so set it before asking to play.
      video.muted = true;
      void video.play().catch(() => {
        /* Autoplay can be refused; the poster frame holds the hero. */
      });
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  async function create() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const project = createProject("");
      await writeProject(project);
      router.push(`/p/${project.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create a project.");
      setBusy(false);
    }
  }

  async function remove(project: ProjectSummary) {
    if (!window.confirm(`Delete “${project.name}”? This removes its renders too.`)) return;
    setRemoving(project.id);
    try {
      await deleteProject(project.id);
      await load();
    } finally {
      setRemoving(undefined);
    }
  }

  return (
    <main className="home">
      <div className="home-reel" aria-hidden="true">
        <video
          ref={reelRef}
          className="home-reel-video"
          src={HERO_REEL}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          tabIndex={-1}
        />
        <span className="home-reel-scrim" />
      </div>

      <header className="home-bar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 6h9l3 3h4v9H8l-4-4z" />
            </svg>
          </span>
          <span className="brand-name">Comfy Cinematic</span>
          <span className="brand-tag">Comfy Router</span>
        </div>
        <div className="home-bar-right">
          <AccountMenu />
          <button type="button" className="primary" onClick={() => void create()} disabled={busy}>
            {busy ? "Creating⬦" : "New project"}
          </button>
        </div>
      </header>

      <section className="home-intro">
        <p className="kicker">Open source · stills and clips</p>
        <h1>Projects</h1>
        <p>
          One canvas per idea. Describe
        </p>
      </section>

      {error && <p className="home-error">{error}</p>}

      {projects === null ? (
        <div className="project-grid" aria-busy="true">
          {[0, 1, 2].map((index) => (
            <div key={index} className="project-card skeleton" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="empty-home">
          <div className="empty-art" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <h2>Nothing on the board</h2>
          <p>Start a canvas and describe what you want to see.</p>
          <button type="button" className="primary" onClick={() => void create()} disabled={busy}>
            Start a project
          </button>
        </div>
      ) : (
        <div className="project-grid">
          {projects.map((project) => (
            <article key={project.id} className="project-card">
              <button
                type="button"
                className="project-open"
                onClick={() => router.push(`/p/${project.id}`)}
                aria-label={`Open ${project.name}`}
              >
                <span className="project-thumb">
                  {project.preview ? <img src={mediaUrl(project.preview)} alt="" /> : <span className="project-blank">Empty canvas</span>}
                </span>
                <span className="project-meta">
                  <strong>{project.name}</strong>
                  <span>
                    {project.count === 0 ? "No renders" : `${project.count} render${project.count === 1 ? "" : "s"}`} ·{" "}
                    {relativeTime(project.updatedAt)}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="project-delete"
                aria-label={`Delete ${project.name}`}
                title="Delete project"
                disabled={removing === project.id}
                onClick={() => void remove(project)}
              >
                {removing === project.id ? "…" : "✕"}
              </button>
            </article>
          ))}
        </div>
      )}

      <footer className="home-footer">
        <span>
          Projects and media live in this browser. Renders are billed to the Comfy workspace behind
          your key.
        </span>
        <a href={GITHUB_REPO.url} target="_blank" rel="noreferrer noopener" title="Browse the source">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M12 .5C5.73.5.75 5.48.75 11.75c0 4.96 3.22 9.17 7.69 10.66.56.1.77-.24.77-.54v-1.9c-3.13.68-3.79-1.5-3.79-1.5-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.68.08-.68 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.39-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.57 0-1.23.44-2.23 1.16-3.02-.12-.28-.5-1.43.11-2.98 0 0 .94-.3 3.08 1.15a10.7 10.7 0 0 1 5.61 0c2.14-1.45 3.08-1.15 3.08-1.15.61 1.55.23 2.7.11 2.98.72.79 1.16 1.79 1.16 3.02 0 4.33-2.64 5.29-5.15 5.56.4.35.76 1.03.76 2.08v3.08c0 .3.2.65.78.54a11.26 11.26 0 0 0 7.68-10.66C23.25 5.48 18.27.5 12 .5Z" />
          </svg>
          {GITHUB_REPO.name}
        </a>
      </footer>
    </main>
  );
}

