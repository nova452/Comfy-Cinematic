/**
 * The gift relay: how a friend's browser gets one free clip out of yours.
 *
 * A browser cannot be reached from the internet, so the host's copy of the app
 * runs this small relay on its own port, behind a tunnel. A friend's page (any
 * copy of the app, anywhere) submits a prompt and references here with a
 * one-time link token; the host's open tab checks in, picks the request up,
 * renders it through its own `/api/video` with its own account, and hands the
 * finished clip back. The relay puts the clip on litterbox (24 hours) and the
 * friend's page collects it.
 *
 * The relay never sees a Comfy key: the host's browser carries its account on
 * the render request, exactly as for its own renders. It holds only link
 * hashes, the requests in flight, and their status.
 *
 * Links persist in a JSON file so a restart does not strand them; requests are
 * in memory, since the tab that renders them is gone after a restart anyway.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { GIFT_FAILED_MESSAGE, GIFT_LIMITS, HOST_OFF_MESSAGE } from "./gift.ts";
import { MAX_PROMPT } from "./harness.ts";
import { isBase64Value, isMediaUri, MAX_REFERENCE_CHARS } from "./media-uri.ts";
import { progressLabel, readProgress, takeOutcome } from "./render-progress.ts";
import { rateLimited } from "./rate-limit.ts";
import { MAX_REF5_IMAGES } from "./video.ts";
import { startTunnel, type Tunnel } from "./gift-tunnel.ts";

/** How long a minted link can be used. */
export const GIFT_LINK_HOURS = 24;

/** The host counts as gone when its tab has not checked in for this long. */
export const HOST_TIMEOUT_MS = 15_000;

/** A finished request is kept as long as litterbox keeps its clip. */
const JOB_KEEP_MS = 24 * 60 * 60 * 1000;

/** The biggest request body the relay reads: a 50 MB clip plus eight stills, as base64. */
export const MAX_RELAY_BODY = 100 * 1024 * 1024;

/** What a friend reads when the gifter's tab is not open. */
export { HOST_OFF_MESSAGE } from "./gift.ts";

/**
 * How long a finished request keeps gifting on for its friend to collect it.
 * The relay holds the clip itself meanwhile, so the friend's page never
 * depends on litterbox letting another site download from it.
 */
export const COLLECT_GRACE_MS = 15 * 60 * 1000;

/* ---------------------------------- types --------------------------------- */

export type GiftLinkStatus = "active" | "used" | "revoked";

export type GiftLink = {
  id: string;
  /** SHA-256 of the link's token; the token itself is shown once and never kept. */
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  status: GiftLinkStatus;
  /** Requests submitted with it; a failed render gives the link back until the cap. */
  attempts: number;
  /** The request it was spent on, so a reloaded page can find it again. */
  jobId?: string;
  /** The delivered clip; kept with the link so it outlives a restart. */
  videoUrl?: string;
  /**
   * Why its last try failed, for the gifter's own gift window. The public
   * routes never send it: the friend only hears that it failed.
   */
  lastError?: string;
};

export type GiftJobStatus = "waiting" | "accepted" | "rendering" | "uploading" | "done" | "failed";

/** What a friend sends: the clip, the cast and the words. The render settings are the gift's. */
export type GiftJobInput = {
  prompt: string;
  /** Let the graph write its own prompt from the clip. */
  auto: boolean;
  /** Character stills, bare base64 JPEG, as the panel prepares them. */
  characters: string[];
  /** The reference clip, as a data URI. */
  video: string;
  /** Where in the clip the render starts, in seconds. */
  start?: number;
};

export type GiftJob = {
  id: string;
  linkId: string;
  tokenHash: string;
  status: GiftJobStatus;
  createdAt: number;
  updatedAt: number;
  /** Dropped once the render is done or failed; it can be tens of megabytes. */
  input?: GiftJobInput;
  /** The host tab rendering it, so a closed tab's request can be picked up again. */
  session?: string;
  /** The host's `/api/video` render id, for live progress. */
  renderId?: string;
  videoUrl?: string;
  error?: string;
  /** The finished clip, held until the friend has it or the grace runs out. */
  clip?: { bytes: Uint8Array; type: string };
  /** The friend's page has seen how it ended. */
  collected?: boolean;
};

/** What the friend's page sees about its request. */
/**
 * The host's render, as its own tile sees it (`/api/video/progress`): the
 * friend's tile shows the same stage, steps and clock.
 */
export type GiftTrack = {
  stage: string;
  step?: number;
  steps?: number;
  node?: string;
  label: string;
  /** Seconds since the host's render started. */
  elapsed: number;
};

export type GiftJobView = {
  id: string;
  status: GiftJobStatus;
  /** 1 is next; absent once the host has it. */
  position?: number;
  /** The host's render, while it runs. */
  track?: GiftTrack;
  videoUrl?: string;
  error?: string;
  hostOnline: boolean;
};

/** Uploads a finished clip somewhere the friend's page can fetch it; answers its URL. */
export type ClipUpload = (bytes: Uint8Array, contentType: string) => Promise<string>;

/* --------------------------------- tokens --------------------------------- */

export function hashLinkToken(token: string) {
  return createHash("sha256").update(token.trim()).digest("hex");
}

function newLinkToken() {
  return randomBytes(32).toString("base64url");
}

/* -------------------------------- litterbox ------------------------------- */

const LITTERBOX_API = "https://litterbox.catbox.moe/resources/internals/api.php";

function clipExtension(contentType: string) {
  if (/webm/i.test(contentType)) return "webm";
  if (/quicktime/i.test(contentType)) return "mov";
  return "mp4";
}

/** Put a clip on litterbox for 24 hours; the answer is its public URL. */
export async function uploadToLitterbox(
  bytes: Uint8Array,
  contentType: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("time", "24h");
  form.append("fileToUpload", new Blob([body], { type: contentType }), `gift.${clipExtension(contentType)}`);

  const response = await fetchImpl(LITTERBOX_API, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  const text = (await response.text()).trim();
  if (!response.ok || !/^https:\/\/\S+$/.test(text)) {
    throw new Error(`litterbox refused the clip (HTTP ${response.status}${text ? `: ${text.slice(0, 120)}` : ""}).`);
  }
  return text;
}

/** A `data:` URI's bytes and type, as a finished render returns its clip. */
export function decodeDataUri(value: string) {
  const head = /^data:([^;,]+);base64,/i.exec(value.slice(0, 128));
  if (!head) return undefined;
  return { bytes: new Uint8Array(Buffer.from(value.slice(head[0].length), "base64")), type: head[1]! };
}

/* ---------------------------------- input --------------------------------- */

/** A friend's request body as a job input, or the reason it is not one. */
export function parseGiftInput(raw: unknown): { ok: true; input: GiftJobInput } | { ok: false; error: string } {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const auto = body.auto === true;
  const prompt = typeof body.prompt === "string" ? body.prompt.replace(/\s+/g, " ").trim() : "";
  if (!auto && !prompt) return { ok: false, error: "Describe the shot first." };
  if (prompt.length > MAX_PROMPT) return { ok: false, error: `Keep the prompt under ${MAX_PROMPT} characters.` };

  const characters = Array.isArray(body.characters)
    ? body.characters.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  if (characters.length === 0) return { ok: false, error: "Add at least one character to cast into the clip." };
  if (characters.length > MAX_REF5_IMAGES) return { ok: false, error: `At most ${MAX_REF5_IMAGES} characters.` };
  if (characters.some((item) => !isBase64Value(item, MAX_REFERENCE_CHARS))) {
    return { ok: false, error: "A character reference is not a valid image." };
  }

  const video = typeof body.video === "string" ? body.video : "";
  if (!video) return { ok: false, error: "Add a reference clip." };
  if (!isMediaUri(video, "video")) return { ok: false, error: "That reference clip is not a usable video." };

  const start = Number(body.start);
  return {
    ok: true,
    input: {
      prompt,
      auto,
      characters,
      video,
      ...(Number.isFinite(start) && start > 0 ? { start } : {}),
    },
  };
}

/* ---------------------------------- relay --------------------------------- */

export type GiftRelayOptions = {
  /** Where links are kept. */
  file: string;
  now?: () => number;
  upload?: ClipUpload;
};

export type GiftRelay = ReturnType<typeof createGiftRelay>;

export function createGiftRelay(options: GiftRelayOptions) {
  const now = options.now ?? Date.now;
  const upload = options.upload ?? ((bytes, type) => uploadToLitterbox(bytes, type));

  let links: GiftLink[] = [];
  let loaded: Promise<void> | undefined;
  const jobs = new Map<string, GiftJob>();
  /** Host tabs by session id, and when each last checked in. */
  const sessions = new Map<string, number>();

  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(work: () => Promise<T> | T): Promise<T> => {
    const run = chain.then(work, work);
    chain = run.catch(() => undefined);
    return run;
  };

  function load() {
    loaded ??= (async () => {
      try {
        const parsed: unknown = JSON.parse(await readFile(options.file, "utf8"));
        links = Array.isArray(parsed) ? (parsed as GiftLink[]) : [];
      } catch {
        links = [];
      }
      // Requests live in memory, so a restart loses any still in flight. Their
      // links were spent on nothing: give them back, within the attempt cap.
      for (const link of links) {
        if (link.status !== "used" || link.videoUrl) continue;
        delete link.jobId;
        if (link.attempts < GIFT_LIMITS.attempts) link.status = "active";
      }
    })();
    return loaded;
  }

  async function save() {
    await mkdir(dirname(options.file), { recursive: true });
    const temporary = `${options.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(links, null, 2));
    await rename(temporary, options.file);
  }

  /**
   * Forget what is over: links revoked, delivered, used up or expired, and old
   * finished requests. A link stays while its request still runs, or while its
   * clip waits for the friend to collect it. A forgotten token is simply not
   * valid any more, so nothing can be reused.
   */
  function sweep() {
    const at = now();
    const before = links.length;
    links = links.filter((link) => {
      const job = link.jobId ? jobs.get(link.jobId) : undefined;
      if (job && unfinished(job)) return true;
      if (job?.status === "done" && !job.collected && at - job.updatedAt < COLLECT_GRACE_MS) return true;
      return link.status === "active" && link.expiresAt > at;
    });
    for (const [id, job] of jobs) {
      const finished = job.status === "done" || job.status === "failed";
      if (finished && at - job.updatedAt > JOB_KEEP_MS) jobs.delete(id);
      else if (finished && at - job.updatedAt > COLLECT_GRACE_MS) delete job.clip;
    }
    return links.length !== before;
  }

  function usable(link: GiftLink) {
    return link.status === "active" && link.expiresAt > now();
  }

  function unfinished(job: GiftJob) {
    return job.status !== "done" && job.status !== "failed";
  }

  function hostOnline() {
    const at = now();
    for (const seen of sessions.values()) if (at - seen < HOST_TIMEOUT_MS) return true;
    return false;
  }

  function sessionLive(session: string | undefined) {
    if (!session) return false;
    const seen = sessions.get(session);
    return seen !== undefined && now() - seen < HOST_TIMEOUT_MS;
  }

  /** The order requests are served in: oldest first. */
  function queue() {
    return [...jobs.values()].filter(unfinished).sort((a, b) => a.createdAt - b.createdAt);
  }

  function view(job: GiftJob): GiftJobView {
    const waiting = queue().filter((item) => item.status === "waiting");
    const position = job.status === "waiting" ? waiting.indexOf(job) + 1 : undefined;
    const live = job.renderId ? readProgress(job.renderId) : undefined;
    return {
      id: job.id,
      status: job.status,
      ...(position ? { position } : {}),
      ...(job.status === "rendering" && live
        ? {
            track: {
              stage: live.stage,
              ...(live.step !== undefined ? { step: live.step } : {}),
              ...(live.steps ? { steps: live.steps } : {}),
              ...(live.node ? { node: live.node } : {}),
              label: progressLabel(live),
              elapsed: Math.round((Date.now() - live.startedAt) / 1000),
            },
          }
        : {}),
      ...(job.videoUrl ? { videoUrl: job.videoUrl } : {}),
      ...(job.error ? { error: job.error } : {}),
      hostOnline: hostOnline(),
    };
  }

  /**
   * The friend hears that it failed, never why: the why is the gifter's
   * machine, and is kept on the link for the gifter's own list.
   */
  function fail(job: GiftJob, reason: string) {
    job.status = "failed";
    job.error = GIFT_FAILED_MESSAGE;
    job.updatedAt = now();
    delete job.input;
    const link = links.find((item) => item.id === job.linkId);
    if (link) link.lastError = reason.slice(0, 300) || "The render failed.";
    giveBack(job);
  }

  /**
   * A request whose host tab closed mid-render. The render itself runs on to
   * the end on the host's server, which keeps its answer under the render id,
   * so the relay collects that instead of rendering (and paying) again.
   */
  function adoptOrphans() {
    for (const job of queue()) {
      if (sessionLive(job.session)) continue;
      if (job.status === "accepted" || (job.status === "rendering" && !job.renderId)) {
        // Taken but never started: back in line.
        job.status = "waiting";
        delete job.session;
        continue;
      }
      if (job.status !== "rendering" || !job.renderId) continue;
      const live = readProgress(job.renderId);
      if (!live) {
        // The render is gone with a server restart: back in line.
        job.status = "waiting";
        delete job.session;
        delete job.renderId;
      } else if (live.stage === "failed") {
        fail(job, live.error ?? "The render failed after its tab closed.");
      } else if (live.stage === "done") {
        const outcome = takeOutcome(job.renderId) as { src?: unknown; error?: unknown } | undefined;
        const clip = typeof outcome?.src === "string" ? decodeDataUri(outcome.src) : undefined;
        if (clip) void relay.finished(job.id, job.session ?? "", clip.bytes, clip.type);
        else fail(job, typeof outcome?.error === "string" ? outcome.error : "The render returned no clip.");
      }
    }
  }

  /** A failed request hands its link back, until the gift's attempts run out. */
  function giveBack(job: GiftJob) {
    const link = links.find((item) => item.id === job.linkId);
    if (!link || link.status !== "used" || link.jobId !== job.id) return;
    if (link.attempts < GIFT_LIMITS.attempts && link.expiresAt > now()) {
      link.status = "active";
      delete link.jobId;
    }
  }

  const relay = {
    /* ------------------------------ the host ------------------------------ */

    /** Mint a link. The token is returned once; only its hash is kept. */
    createLink() {
      return locked(async () => {
        await load();
        sweep();
        const token = newLinkToken();
        const at = now();
        const link: GiftLink = {
          id: randomUUID(),
          tokenHash: hashLinkToken(token),
          createdAt: at,
          expiresAt: at + GIFT_LINK_HOURS * 60 * 60 * 1000,
          status: "active",
          attempts: 0,
        };
        links.push(link);
        await save();
        return { link: { ...link }, token };
      });
    },

    revokeLink(id: string) {
      return locked(async () => {
        await load();
        const link = links.find((item) => item.id === id);
        if (!link) return false;
        link.status = "revoked";
        // A request that has not started yet goes with it.
        const job = link.jobId ? jobs.get(link.jobId) : undefined;
        if (job && job.status === "waiting") {
          job.status = "failed";
          job.error = "The host withdrew this gift.";
          job.updatedAt = now();
          delete job.input;
        }
        await save();
        return true;
      });
    },

    /** The host's list: every link still worth showing, newest first. */
    listLinks() {
      return locked(async () => {
        await load();
        if (sweep()) await save();
        return links
          .map((link) => {
            const job = link.jobId ? jobs.get(link.jobId) : undefined;
            return { ...link, expired: link.expiresAt <= now(), ...(job ? { job: view(job) } : {}) };
          })
          .sort((a, b) => b.createdAt - a.createdAt);
      });
    },

    /** Whether gifting has anything to do: a usable link, or a request still in flight. */
    active() {
      return locked(async () => {
        await load();
        if (sweep()) await save();
        const uncollected = [...jobs.values()].some(
          (job) => !unfinished(job) && !job.collected && now() - job.updatedAt < COLLECT_GRACE_MS,
        );
        return links.some(usable) || queue().length > 0 || uncollected;
      });
    },

    hostOnline,

    /**
     * A host tab checks in, and takes the next request if it is free. A
     * request whose tab went quiet mid-render is offered again.
     */
    checkIn(session: string) {
      return locked(async () => {
        await load();
        sessions.set(session, now());
        adoptOrphans();
        const order = queue();
        // One gift at a time per tab: it answers its own first.
        if (order.some((job) => job.session === session && job.status !== "waiting")) return undefined;
        const next = order.find((job) => job.status === "waiting");
        if (!next?.input) return undefined;
        next.status = "accepted";
        next.session = session;
        delete next.renderId;
        next.updatedAt = now();
        return { id: next.id, input: next.input };
      });
    },

    /** The host's render is running under this render id. */
    started(id: string, session: string, renderId: string) {
      return locked(() => {
        const job = jobs.get(id);
        if (!job || job.session !== session || !unfinished(job)) return false;
        job.status = "rendering";
        job.renderId = renderId;
        job.updatedAt = now();
        return true;
      });
    },

    /**
     * The host's render failed or was cancelled. Its reason stays with the
     * host's tab, which already shows it; the friend gets one plain line.
     */
    failed(id: string, session: string, error: string) {
      return locked(async () => {
        await load();
        const job = jobs.get(id);
        if (!job || job.session !== session || !unfinished(job)) return false;
        fail(job, error);
        await save();
        return true;
      });
    },

    /** The host's render finished: put the clip up and tell the friend where. */
    async finished(id: string, session: string, bytes: Uint8Array, contentType: string) {
      const claimed = await locked(() => {
        const job = jobs.get(id);
        if (!job || job.session !== session || !unfinished(job)) return undefined;
        job.status = "uploading";
        job.updatedAt = now();
        return job;
      });
      if (!claimed) return false;

      try {
        const url = await upload(bytes, contentType);
        await locked(async () => {
          claimed.status = "done";
          claimed.videoUrl = url;
          claimed.clip = { bytes, type: contentType };
          claimed.updatedAt = now();
          delete claimed.input;
          const link = links.find((item) => item.id === claimed.linkId);
          if (link) {
            link.videoUrl = url;
            delete link.lastError;
          }
          await save();
        });
        return true;
      } catch (error) {
        await relay.failed(
          id,
          session,
          `The clip could not be uploaded: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        return false;
      }
    },

    /* ----------------------------- the friend ----------------------------- */

    /** The relay's public routes, as the tunnel delivers them. */
    async handle(request: Request): Promise<Response> {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

      const url = new URL(request.url);
      const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim() ?? "";

      if (url.pathname === "/gift/link" && request.method === "GET") {
        if (rateLimited(request, "relay-link", 30, 60_000)) return tooMany();
        if (!token) return reply({ error: "This gift link has no token." }, 400);
        return locked(async () => {
          await load();
          const link = links.find((item) => item.tokenHash === hashLinkToken(token));
          if (!link || link.status === "revoked") return reply({ error: "This gift link is not valid." }, 404);
          adoptOrphans();
          const job = link.jobId ? jobs.get(link.jobId) : undefined;
          if (job) return reply({ status: "used", job: view(job), limits: GIFT_LIMITS });
          if (link.videoUrl) {
            const done: GiftJobView = {
              id: link.jobId ?? link.id,
              status: "done",
              videoUrl: link.videoUrl,
              hostOnline: hostOnline(),
            };
            return reply({ status: "used", job: done, limits: GIFT_LIMITS });
          }
          if (link.expiresAt <= now()) return reply({ error: "This gift link has expired." }, 410);
          if (link.status !== "active") return reply({ error: "This gift link has already been used." }, 410);
          return reply({ status: "active", expiresAt: link.expiresAt, hostOnline: hostOnline(), limits: GIFT_LIMITS });
        });
      }

      if (url.pathname === "/gift/jobs" && request.method === "POST") {
        if (rateLimited(request, "relay-submit", 6, 60_000)) return tooMany();
        if (!token) return reply({ error: "This gift link has no token." }, 400);
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return reply({ error: "Send a JSON request." }, 400);
        }
        const parsed = parseGiftInput(body);
        if (!parsed.ok) return reply({ error: parsed.error }, 400);

        return locked(async () => {
          await load();
          const link = links.find((item) => item.tokenHash === hashLinkToken(token));
          if (!link || link.status === "revoked") return reply({ error: "This gift link is not valid." }, 404);
          if (link.expiresAt <= now()) return reply({ error: "This gift link has expired." }, 410);
          if (link.status !== "active") return reply({ error: "This gift link has already been used." }, 410);
          // An absent host would leave the friend waiting on nothing; the link
          // is not spent, so they can come back later.
          if (!hostOnline()) return reply({ error: HOST_OFF_MESSAGE, code: "host_off" }, 503);

          const at = now();
          const job: GiftJob = {
            id: randomUUID(),
            linkId: link.id,
            tokenHash: link.tokenHash,
            status: "waiting",
            createdAt: at,
            updatedAt: at,
            input: parsed.input,
          };
          jobs.set(job.id, job);
          link.status = "used";
          link.attempts += 1;
          link.jobId = job.id;
          await save();
          return reply(view(job), 202);
        });
      }

      const jobPath = /^\/gift\/jobs\/([0-9a-f-]{36})$/i.exec(url.pathname);
      if (jobPath && request.method === "GET") {
        if (rateLimited(request, "relay-status", 120, 60_000)) return tooMany();
        return locked(() => {
          adoptOrphans();
          const job = jobs.get(jobPath[1]!.toLowerCase());
          // Only the link that made a request can read it.
          if (!job || !token || job.tokenHash !== hashLinkToken(token)) {
            return reply({ error: "No such gift request." }, 404);
          }
          // A failure is collected once it is seen; a clip once it is downloaded.
          if (job.status === "failed" || (job.status === "done" && !job.clip)) job.collected = true;
          return reply(view(job));
        });
      }

      const videoPath = /^\/gift\/jobs\/([0-9a-f-]{36})\/video$/i.exec(url.pathname);
      if (videoPath && request.method === "GET") {
        if (rateLimited(request, "relay-video", 20, 60_000)) return tooMany();
        return locked(() => {
          const job = jobs.get(videoPath[1]!.toLowerCase());
          if (!job || !token || job.tokenHash !== hashLinkToken(token)) {
            return reply({ error: "No such gift request." }, 404);
          }
          if (!job.clip) return reply({ error: "The clip is not here; use its litterbox link." }, 404);
          const { bytes, type } = job.clip;
          job.collected = true;
          return new Response(new Blob([bytes as BlobPart], { type }), {
            headers: { ...CORS, "content-type": type, "cache-control": "no-store" },
          });
        });
      }

      return reply({ error: "Not found." }, 404);
    },
  };

  return relay;
}

/* ---------------------------------- http ---------------------------------- */

/**
 * Any copy of the app may call the relay, wherever it is served from. No
 * cookies are involved: the link token rides in the Authorization header.
 */
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "600",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
  });
}

function tooMany() {
  return reply({ error: "Too many requests. Try again in a minute." }, 429);
}

/** A Node request as a Fetch one, refusing a body past the cap. */
async function toRequest(incoming: IncomingMessage): Promise<Request | "too-large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += (chunk as Buffer).length;
    if (size > MAX_RELAY_BODY) return "too-large";
    chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  const method = incoming.method ?? "GET";
  return new Request(`http://relay${incoming.url ?? "/"}`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" || method === "OPTIONS" ? {} : { body: Buffer.concat(chunks) }),
  });
}

async function send(response: Response, outgoing: ServerResponse) {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

/** Serve a relay over HTTP on the loopback address; the tunnel connects to it there. */
export function listenRelay(relay: GiftRelay, port: number): Promise<Server> {
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        const request = await toRequest(incoming);
        if (request === "too-large") {
          incoming.resume();
          return send(reply({ error: "That request is too big." }, 413), outgoing);
        }
        await send(await relay.handle(request), outgoing);
      } catch (error) {
        console.error("[gift relay] request failed", error);
        if (!outgoing.headersSent) await send(reply({ error: "The gift relay failed." }, 500), outgoing);
        else outgoing.end();
      }
    })();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/* -------------------------------- singleton ------------------------------- */

const shared = globalThis as typeof globalThis & {
  __giftRelay?: {
    relay: GiftRelay;
    server?: Server;
    port?: number;
    publicUrl?: string;
    tunnel?: Tunnel;
    /** Why the last tunnel did not come up, for the gift window. */
    tunnelError?: string;
    /** Turns gifting off once nothing is left, even with no host tab checking in. */
    idleCheck?: ReturnType<typeof setInterval>;
  };
};

/** This process's relay. Next can load a module once per route, so it hangs off `globalThis`. */
export function giftRelay(env = process.env) {
  shared.__giftRelay ??= {
    relay: createGiftRelay({ file: env.GIFT_LINKS_FILE?.trim() || ".data/gift-links.json" }),
  };
  return shared.__giftRelay;
}

export function relayPort(env = process.env) {
  const port = Number(env.GIFT_RELAY_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 3100;
}

/**
 * Start serving the relay, once, and its tunnel. A fixed `GIFT_RELAY_URL`
 * means the host runs its own tunnel; `GIFT_TUNNEL=off` means none at all.
 */
export async function startRelay(env = process.env) {
  const state = giftRelay(env);
  if (!state.server) {
    const port = relayPort(env);
    state.server = await listenRelay(state.relay, port);
    state.port = port;
    state.idleCheck = setInterval(() => void stopIfIdle(), 60_000);
    state.idleCheck.unref?.();
  }
  if (!state.tunnel && !env.GIFT_RELAY_URL?.trim() && env.GIFT_TUNNEL?.trim().toLowerCase() !== "off") {
    // A failure from an earlier start is not this one's.
    delete state.tunnelError;
    try {
      const tunnel = await startTunnel(state.port ?? relayPort(env), () => {
        if (state.tunnel !== tunnel) return;
        delete state.tunnel;
        delete state.publicUrl;
        state.tunnelError = "The tunnel stopped. Create a link to start it again.";
      }, env);
      // Gifting may have been turned off while the tunnel came up.
      if (!state.server) tunnel.child.kill();
      else {
        state.tunnel = tunnel;
        state.publicUrl = tunnel.url;
        delete state.tunnelError;
      }
    } catch (error) {
      state.tunnelError = error instanceof Error ? error.message : "The tunnel could not start.";
      console.error("[gift relay] tunnel failed", error);
    }
  }
  return state;
}

/** Stop serving it; links and requests stay for the next start. */
export async function stopRelay() {
  const state = shared.__giftRelay;
  if (!state?.server) return;
  const server = state.server;
  delete state.server;
  delete state.port;
  clearInterval(state.idleCheck);
  delete state.idleCheck;
  const tunnel = state.tunnel;
  delete state.tunnel;
  delete state.publicUrl;
  tunnel?.child.kill();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Gifting turns itself off once nothing is left to serve. True when it just did. */
export async function stopIfIdle() {
  const state = shared.__giftRelay;
  if (!state?.server || (await state.relay.active())) return false;
  await stopRelay();
  return true;
}

/** Where friends reach the relay: the tunnel once it is up, else this machine. */
export function relayUrl(env = process.env) {
  const state = shared.__giftRelay;
  return (state?.publicUrl || env.GIFT_RELAY_URL?.trim() || `http://127.0.0.1:${state?.port ?? relayPort(env)}`).replace(
    /\/+$/,
    "",
  );
}

/** The copy of the app a friend opens a link in. */
export function giftFrontendUrl(env = process.env) {
  return (env.GIFT_FRONTEND_URL?.trim() || "https://comfy-cinematic.ai.studio").replace(/\/+$/, "");
}

/**
 * A friend's link. The token and relay ride in the fragment, which a browser
 * never sends to the server that serves the page.
 */
export function giftLinkUrl(token: string, env = process.env) {
  const fragment = new URLSearchParams({ gift: token, host: relayUrl(env) });
  return `${giftFrontendUrl(env)}/openjutsu-prime#${fragment}`;
}

/** The host's view of gifting, for its gift window. */
export async function giftingStatus(env = process.env) {
  const state = giftRelay(env);
  return {
    enabled: Boolean(state.server),
    relay: state.server ? relayUrl(env) : null,
    tunnel: Boolean(state.publicUrl),
    ...(state.server && !state.publicUrl && state.tunnelError ? { tunnelError: state.tunnelError } : {}),
    hostOnline: state.relay.hostOnline(),
    links: (await state.relay.listLinks()).map(({ tokenHash: _hash, ...link }) => link),
  };
}
