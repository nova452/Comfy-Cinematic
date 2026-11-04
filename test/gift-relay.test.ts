import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { GIFT_FAILED_MESSAGE, GIFT_LIMITS } from "../lib/gift.ts";
import {
  createGiftRelay,
  decodeDataUri,
  GIFT_LINK_HOURS,
  HOST_OFF_MESSAGE,
  HOST_TIMEOUT_MS,
  listenRelay,
  parseGiftInput,
  uploadToLitterbox,
} from "../lib/gift-relay.ts";
import { isOwnerRequest } from "../lib/local-request.ts";
import { resetRateLimits } from "../lib/rate-limit.ts";
import { finishProgress, reportProgress } from "../lib/render-progress.ts";

const STILL = "A".repeat(120);
const CLIP = `data:video/mp4;base64,${"AAAA".repeat(40)}`;
const INPUT = { prompt: "she turns to the camera", characters: [STILL], video: CLIP };

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
beforeEach(() => resetRateLimits());

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "gift-relay-"));
  dirs.push(dir);
  const file = join(dir, "links.json");
  const clock = { at: 1_700_000_000_000 };
  const uploads: { bytes: Uint8Array; type: string }[] = [];
  const make = () =>
    createGiftRelay({
      file,
      now: () => clock.at,
      upload: async (bytes, type) => {
        uploads.push({ bytes, type });
        return `https://litter.catbox.moe/clip${uploads.length}.mp4`;
      },
    });
  return { relay: make(), make, file, clock, uploads };
}

function call(relay: ReturnType<typeof createGiftRelay>, path: string, token?: string, body?: unknown) {
  return relay.handle(
    new Request(`http://relay${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function json(response: Response) {
  return (await response.json()) as Record<string, any>;
}

test("a link is good for one request, and only while the host is there", async () => {
  const { relay } = await setup();
  const { token, link } = await relay.createLink();
  assert.equal(link.expiresAt - link.createdAt, GIFT_LINK_HOURS * 3_600_000);

  const checked = await json(await call(relay, "/gift/link", token));
  assert.equal(checked.status, "active");
  assert.equal(checked.hostOnline, false);
  assert.deepEqual(checked.limits, GIFT_LIMITS);

  // No host tab: refused, and the link is not spent.
  const off = await call(relay, "/gift/jobs", token, INPUT);
  assert.equal(off.status, 503);
  assert.deepEqual(await json(off), { error: HOST_OFF_MESSAGE, code: "host_off" });
  assert.equal((await json(await call(relay, "/gift/link", token))).status, "active");

  await relay.checkIn(randomUUID());
  const submitted = await call(relay, "/gift/jobs", token, INPUT);
  assert.equal(submitted.status, 202);
  const job = await json(submitted);
  assert.equal(job.status, "waiting");
  assert.equal(job.position, 1);

  const again = await call(relay, "/gift/jobs", token, INPUT);
  assert.equal(again.status, 410);
  // The spent link still finds its request, for a page that reloaded.
  const reread = await json(await call(relay, "/gift/link", token));
  assert.equal(reread.status, "used");
  assert.equal(reread.job.id, job.id);
});

test("the host tab takes a request, renders it, and the friend gets a link to the clip", async () => {
  const { relay, uploads } = await setup();
  const session = randomUUID();
  const { token } = await relay.createLink();
  await relay.checkIn(session);
  const { id } = await json(await call(relay, "/gift/jobs", token, INPUT));

  const taken = await relay.checkIn(session);
  assert.equal(taken?.id, id);
  assert.deepEqual(taken?.input, { prompt: INPUT.prompt, auto: false, characters: [STILL], video: CLIP });
  // One at a time: the tab is busy until it answers.
  assert.equal(await relay.checkIn(session), undefined);

  const renderId = randomUUID();
  assert.equal(await relay.started(id, session, renderId), true);
  reportProgress(renderId, { stage: "running", step: 3, steps: 8, node: "SamplerCustomAdvanced" });
  const rendering = await json(await call(relay, `/gift/jobs/${id}`, token));
  assert.equal(rendering.status, "rendering");
  assert.equal(rendering.track.label, "Sampling 3/8");
  assert.equal(rendering.track.step, 3);
  assert.equal(rendering.track.steps, 8);

  // Another tab cannot report on it.
  assert.equal(await relay.failed(id, randomUUID(), "nope"), false);

  const bytes = new Uint8Array([1, 2, 3, 4]);
  assert.equal(await relay.finished(id, session, bytes, "video/mp4"), true);
  assert.deepEqual(uploads, [{ bytes, type: "video/mp4" }]);
  const done = await json(await call(relay, `/gift/jobs/${id}`, token));
  assert.equal(done.status, "done");
  assert.equal(done.videoUrl, "https://litter.catbox.moe/clip1.mp4");
  assert.equal("input" in done, false);
});

test("a request can only be read with the link that made it", async () => {
  const { relay } = await setup();
  await relay.checkIn(randomUUID());
  const first = await relay.createLink();
  const second = await relay.createLink();
  const { id } = await json(await call(relay, "/gift/jobs", first.token, INPUT));

  assert.equal((await call(relay, `/gift/jobs/${id}`, second.token)).status, 404);
  assert.equal((await call(relay, `/gift/jobs/${id}`)).status, 404);
  assert.equal((await call(relay, `/gift/jobs/${id}`, first.token)).status, 200);
});

test("a failed render gives the link back until its attempts run out", async () => {
  const { relay } = await setup();
  const session = randomUUID();
  const { token } = await relay.createLink();

  for (let attempt = 1; attempt <= GIFT_LIMITS.attempts; attempt += 1) {
    await relay.checkIn(session);
    const submitted = await call(relay, "/gift/jobs", token, INPUT);
    assert.equal(submitted.status, 202, `attempt ${attempt}`);
    const { id } = await json(submitted);
    await relay.checkIn(session);
    await relay.failed(id, session, "clip_name: 'qwen3vl_32b.safetensors' not in [...]");
    const status = await json(await call(relay, `/gift/jobs/${id}`, token));
    assert.equal(status.status, "failed");
    // The host's own reason never reaches the friend.
    assert.equal(status.error, GIFT_FAILED_MESSAGE);
  }
  await relay.checkIn(session);
  assert.equal((await call(relay, "/gift/jobs", token, INPUT)).status, 410);
});

test("links expire after 24 hours and can be revoked", async () => {
  const { relay, clock } = await setup();
  const expiring = await relay.createLink();
  clock.at += GIFT_LINK_HOURS * 3_600_000 + 1;
  assert.equal((await call(relay, "/gift/link", expiring.token)).status, 410);

  const session = randomUUID();
  await relay.checkIn(session);
  const revoked = await relay.createLink();
  const { id } = await json(await call(relay, "/gift/jobs", revoked.token, INPUT));
  assert.equal(await relay.revokeLink(revoked.link.id), true);
  assert.equal((await call(relay, "/gift/link", revoked.token)).status, 404);
  // Its request had not started, so it goes too.
  assert.equal(await relay.checkIn(session), undefined);
  const status = await json(await call(relay, `/gift/jobs/${id}`, revoked.token));
  assert.equal(status.status, "failed");
});

test("the host is offline once its tab stops checking in", async () => {
  const { relay, clock } = await setup();
  await relay.checkIn(randomUUID());
  assert.equal(relay.hostOnline(), true);
  clock.at += HOST_TIMEOUT_MS + 1;
  assert.equal(relay.hostOnline(), false);
});

test("gifting is active while a link is usable or a request is in flight", async () => {
  const { relay, clock } = await setup();
  assert.equal(await relay.active(), false);
  const { token } = await relay.createLink();
  assert.equal(await relay.active(), true);

  await relay.checkIn(randomUUID());
  await call(relay, "/gift/jobs", token, INPUT);
  clock.at += GIFT_LINK_HOURS * 3_600_000 + 1;
  // The link has expired, but its request still waits for the host.
  assert.equal(await relay.active(), true);
});

test("a tab that closes mid-render does not cost a second render", async () => {
  const { relay, clock, uploads } = await setup();
  const session = randomUUID();
  const { token } = await relay.createLink();
  await relay.checkIn(session);
  const { id } = await json(await call(relay, "/gift/jobs", token, INPUT));
  await relay.checkIn(session);
  const renderId = randomUUID();
  await relay.started(id, session, renderId);
  reportProgress(renderId, { stage: "running" });

  // The tab goes away; the render runs on and keeps its answer.
  clock.at += HOST_TIMEOUT_MS + 1;
  finishProgress(renderId, true, { kind: "video", src: `data:video/mp4;base64,${Buffer.from("clip").toString("base64")}` });

  // A new tab is not handed the same gift again…
  const fresh = randomUUID();
  assert.equal(await relay.checkIn(fresh), undefined);
  // …because the relay collects the finished render itself.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(uploads.length, 1);
  assert.equal(Buffer.from(uploads[0]!.bytes).toString(), "clip");
  assert.equal((await json(await call(relay, `/gift/jobs/${id}`, token))).status, "done");
});

test("a request taken by a tab that closed before rendering goes back in line", async () => {
  const { relay, clock } = await setup();
  const { token } = await relay.createLink();
  const gone = randomUUID();
  await relay.checkIn(gone);
  const { id } = await json(await call(relay, "/gift/jobs", token, INPUT));
  assert.equal((await relay.checkIn(gone))?.id, id);

  clock.at += HOST_TIMEOUT_MS + 1;
  assert.equal((await relay.checkIn(randomUUID()))?.id, id);
});

test("a restart gives back links spent on requests it lost, and keeps delivered ones", async () => {
  const { relay, make } = await setup();
  const session = randomUUID();
  await relay.checkIn(session);

  // One request is rendered and delivered…
  const delivered = await relay.createLink();
  const { id } = await json(await call(relay, "/gift/jobs", delivered.token, INPUT));
  assert.equal((await relay.checkIn(session))?.id, id);
  assert.equal(await relay.finished(id, session, new Uint8Array([1]), "video/mp4"), true);

  // …and one is still waiting when the app restarts.
  const lost = await relay.createLink();
  assert.equal((await call(relay, "/gift/jobs", lost.token, INPUT)).status, 202);

  const restarted = make();
  const deliveredView = await json(await call(restarted, "/gift/link", delivered.token));
  assert.equal(deliveredView.status, "used");
  assert.equal(deliveredView.job.videoUrl, "https://litter.catbox.moe/clip1.mp4");
  assert.equal((await json(await call(restarted, "/gift/link", lost.token))).status, "active");
});

test("links are stored as hashes, never as tokens", async () => {
  const { relay, file } = await setup();
  const { token } = await relay.createLink();
  const stored = await readFile(file, "utf8");
  assert.equal(stored.includes(token), false);
});

test("a friend's request is checked before it is queued", () => {
  assert.equal(parseGiftInput(INPUT).ok, true);
  assert.equal(parseGiftInput({ ...INPUT, prompt: "", auto: true }).ok, true);
  assert.deepEqual(parseGiftInput({ ...INPUT, prompt: " " }), { ok: false, error: "Describe the shot first." });
  assert.equal(parseGiftInput({ ...INPUT, prompt: "x".repeat(901) }).ok, false);
  assert.equal(parseGiftInput({ ...INPUT, characters: [] }).ok, false);
  assert.equal(parseGiftInput({ ...INPUT, characters: Array(9).fill(STILL) }).ok, false);
  assert.equal(parseGiftInput({ ...INPUT, characters: ["not an image"] }).ok, false);
  assert.equal(parseGiftInput({ ...INPUT, video: "" }).ok, false);
  assert.equal(parseGiftInput({ ...INPUT, video: "data:image/png;base64,AAAA" }).ok, false);
  assert.equal(parseGiftInput(null).ok, false);
});

test("the gifting routes answer only the host's own pages", () => {
  const local = (headers: Record<string, string> = {}) =>
    new Request("http://127.0.0.1:3000/api/gifting", { headers: { host: "127.0.0.1:3000", ...headers } });
  assert.equal(isOwnerRequest(local()), true);
  assert.equal(isOwnerRequest(local({ "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:3000" })), true);
  assert.equal(isOwnerRequest(local({ host: "localhost:3000" })), true);
  // Next itself fills in the forwarding headers from the socket.
  const nextFilled = { "x-forwarded-for": "::ffff:127.0.0.1", "x-forwarded-host": "127.0.0.1:3000" };
  assert.equal(isOwnerRequest(local(nextFilled)), true);
  assert.equal(isOwnerRequest(local({ "x-forwarded-for": "::1" })), true);

  // Through a tunnel or proxy.
  assert.equal(isOwnerRequest(local({ "cf-connecting-ip": "1.2.3.4" })), false);
  assert.equal(isOwnerRequest(local({ "x-forwarded-for": "1.2.3.4" })), false);
  assert.equal(isOwnerRequest(local({ "x-forwarded-for": "1.2.3.4, 127.0.0.1" })), false);
  assert.equal(isOwnerRequest(local({ "x-forwarded-host": "abc.trycloudflare.com" })), false);
  // A rebinding domain that resolves to this machine.
  assert.equal(isOwnerRequest(local({ host: "evil.example:3000" })), false);
  // Another site in the host's own browser.
  assert.equal(isOwnerRequest(local({ "sec-fetch-site": "cross-site" })), false);
  assert.equal(isOwnerRequest(local({ origin: "https://evil.example" })), false);
});

test("the relay serves over HTTP with CORS, and nothing but its own routes", async (t) => {
  const { relay } = await setup();
  const server = await listenRelay(relay, 0);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  const preflight = await fetch(`${base}/gift/jobs`, {
    method: "OPTIONS",
    headers: { origin: "https://comfy-cinematic.ai.studio", "access-control-request-method": "POST" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);

  const { token } = await relay.createLink();
  const checked = await fetch(`${base}/gift/link`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(checked.status, 200);
  assert.equal(((await checked.json()) as { status: string }).status, "active");

  for (const path of ["/", "/api/video", "/api/gifting", "/gift/jobs"]) {
    const response = await fetch(`${base}${path}`);
    assert.notEqual(response.status, 200, path);
  }
});

test("litterbox gets the clip for 24 hours, and a refusal is an error", async () => {
  let sent: FormData | undefined;
  const ok = (async (_url: string, init: RequestInit) => {
    sent = init.body as FormData;
    return new Response("https://litter.catbox.moe/abc123.mp4\n");
  }) as unknown as typeof fetch;
  assert.equal(await uploadToLitterbox(new Uint8Array([1, 2]), "video/mp4", ok), "https://litter.catbox.moe/abc123.mp4");
  assert.equal(sent?.get("reqtype"), "fileupload");
  assert.equal(sent?.get("time"), "24h");
  assert.equal((sent?.get("fileToUpload") as File).name, "gift.mp4");

  const refused = (async () => new Response("File too large", { status: 412 })) as unknown as typeof fetch;
  await assert.rejects(() => uploadToLitterbox(new Uint8Array([1]), "video/mp4", refused), /litterbox refused/);
});

test("a finished clip's data URI decodes to its bytes and type", () => {
  const clip = decodeDataUri(`data:video/webm;base64,${Buffer.from("hello").toString("base64")}`);
  assert.equal(clip?.type, "video/webm");
  assert.equal(Buffer.from(clip!.bytes).toString(), "hello");
  assert.equal(decodeDataUri("not a uri"), undefined);
});

test("the tunnel's address is read from cloudflared's log", async () => {
  const { tunnelUrlIn } = await import("../lib/gift-tunnel.ts");
  const log =
    "2026-11-03T10:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |\n" +
    "2026-11-03T10:00:00Z INF |  https://calm-river-owl-7.trycloudflare.com                                                |";
  assert.equal(tunnelUrlIn(log), "https://calm-river-owl-7.trycloudflare.com");
  assert.equal(tunnelUrlIn("INF Requesting new quick Tunnel on trycloudflare.com..."), undefined);
});

test("gifting stays on until the friend has collected the clip, which the relay hands over itself", async () => {
  const { relay, clock } = await setup();
  const session = randomUUID();
  const { token } = await relay.createLink();
  await relay.checkIn(session);
  const { id } = await json(await call(relay, "/gift/jobs", token, INPUT));
  await relay.checkIn(session);
  await relay.started(id, session, randomUUID());
  const bytes = new Uint8Array([1, 2, 3, 4]);
  assert.equal(await relay.finished(id, session, bytes, "video/mp4"), true);

  // The link is spent and nothing is queued, but the clip is not collected yet.
  assert.equal(await relay.active(), true);
  // Seeing "done" is not collecting it; downloading it is.
  assert.equal((await json(await call(relay, `/gift/jobs/${id}`, token))).status, "done");
  assert.equal(await relay.active(), true);
  assert.equal((await call(relay, `/gift/jobs/${id}/video`, "wrong-token")).status, 404);
  const video = await call(relay, `/gift/jobs/${id}/video`, token);
  assert.equal(video.status, 200);
  assert.equal(video.headers.get("content-type"), "video/mp4");
  assert.equal(video.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(new Uint8Array(await video.arrayBuffer()), bytes);
  assert.equal(await relay.active(), false);

  // A friend who never comes back does not keep gifting on forever.
  const second = await relay.createLink();
  const { id: other } = await json(await call(relay, "/gift/jobs", second.token, INPUT));
  await relay.checkIn(session);
  await relay.started(other, session, randomUUID());
  await relay.finished(other, session, bytes, "video/mp4");
  assert.equal(await relay.active(), true);
  clock.at += 16 * 60 * 1000;
  assert.equal(await relay.active(), false);
});

test("a friend's link carries its token and relay in the fragment, and only a safe relay", async () => {
  const { giftFromFragment, giftHostOk } = await import("../lib/gift-client.ts");
  const token = "a".repeat(43);
  assert.deepEqual(giftFromFragment(`#gift=${token}&host=https%3A%2F%2Fx.trycloudflare.com%2F`), {
    token,
    host: "https://x.trycloudflare.com",
  });
  assert.equal(giftFromFragment(`#gift=${token}&host=http%3A%2F%2Fevil.example`), undefined);
  assert.equal(giftFromFragment(`#gift=short&host=https%3A%2F%2Fx.trycloudflare.com`), undefined);
  assert.equal(giftHostOk("http://127.0.0.1:3100"), true);
  assert.equal(giftHostOk("https://x.trycloudflare.com/path"), false);
});

test("the relay's rate limit counts each client by the address Cloudflare saw", async () => {
  const { clientAddress, rateLimited } = await import("../lib/rate-limit.ts");
  const from = (headers: Record<string, string>) => new Request("http://relay/gift/link", { headers });
  // A spoofed x-forwarded-for does not dodge the budget behind the tunnel.
  assert.equal(clientAddress(from({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4" })), "203.0.113.9");
  assert.equal(clientAddress(from({ "x-forwarded-for": "198.51.100.1, 127.0.0.1" })), "198.51.100.1");
  const at = 1_700_000_000_000;
  for (let index = 0; index < 3; index += 1) {
    assert.equal(rateLimited(from({ "cf-connecting-ip": "203.0.113.9" }), "t", 3, 60_000, at), 0);
  }
  assert.ok(rateLimited(from({ "cf-connecting-ip": "203.0.113.9" }), "t", 3, 60_000, at) > 0);
  assert.equal(rateLimited(from({ "cf-connecting-ip": "203.0.113.10" }), "t", 3, 60_000, at), 0);
  assert.equal(rateLimited(from({ "cf-connecting-ip": "203.0.113.9" }), "t", 3, 60_000, at + 60_001), 0);
});

test("only the relay's own refusal kills a gift link; silence or a busy relay proves nothing", async (t) => {
  const { giftLinkState } = await import("../lib/gift-client.ts");
  const gift = { token: "a".repeat(43), host: "https://x.trycloudflare.com" };
  const answer = (status: number, body: string) =>
    t.mock.method(globalThis, "fetch", async () => new Response(body, { status }));

  // A made-up token on a relay that answers is refused for what it is.
  answer(404, JSON.stringify({ error: "This gift link is not valid." }));
  assert.deepEqual(await giftLinkState(gift), { state: "dead", error: "This gift link is not valid." });
  answer(410, JSON.stringify({ error: "This gift link has expired." }));
  assert.equal((await giftLinkState(gift)).state, "dead");

  // No relay, the tunnel's page for a missing origin, or a rate limit: unknown.
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.deepEqual(await giftLinkState(gift), { state: "off" });
  answer(530, "<html>origin unreachable</html>");
  assert.deepEqual(await giftLinkState(gift), { state: "off" });
  answer(429, JSON.stringify({ error: "Too many requests. Try again in a minute." }));
  assert.deepEqual(await giftLinkState(gift), { state: "off" });

  answer(200, JSON.stringify({ status: "active" }));
  assert.deepEqual(await giftLinkState(gift), { state: "active" });
});

test("finished links clear themselves; running and uncollected ones stay", async () => {
  const { relay } = await setup();
  const session = randomUUID();
  const ids = async () => (await relay.listLinks()).map((link) => link.id);

  const revoked = await relay.createLink();
  await relay.revokeLink(revoked.link.id);
  assert.equal((await ids()).includes(revoked.link.id), false);

  // Three failed tries use a link up.
  const spent = await relay.createLink();
  for (let attempt = 0; attempt < GIFT_LIMITS.attempts; attempt += 1) {
    await relay.checkIn(session);
    const { id } = await json(await call(relay, "/gift/jobs", spent.token, INPUT));
    await relay.checkIn(session);
    assert.equal((await ids()).includes(spent.link.id), true, "kept while its request runs");
    await relay.failed(id, session, "boom");
    // The friend's page sees how it ended.
    await call(relay, `/gift/jobs/${id}`, spent.token);
  }
  assert.equal((await ids()).includes(spent.link.id), false);

  // A delivered clip keeps its link until the friend has it.
  const delivered = await relay.createLink();
  await relay.checkIn(session);
  const { id } = await json(await call(relay, "/gift/jobs", delivered.token, INPUT));
  await relay.checkIn(session);
  await relay.finished(id, session, new Uint8Array([1, 2]), "video/mp4");
  assert.equal((await ids()).includes(delivered.link.id), true);
  const video = await call(relay, `/gift/jobs/${id}/video`, delivered.token);
  assert.equal(video.status, 200);
  assert.equal((await ids()).includes(delivered.link.id), false);
  assert.equal(await relay.active(), false);
});

test("the gifter's list keeps why a try failed; the friend's answers never carry it", async () => {
  const { relay } = await setup();
  const session = randomUUID();
  const { token, link } = await relay.createLink();
  await relay.checkIn(session);
  const { id } = await json(await call(relay, "/gift/jobs", token, INPUT));
  await relay.checkIn(session);
  const reason = "clip_name: 'qwen3vl_32b.safetensors' not in [...]";
  await relay.failed(id, session, reason);

  const mine = (await relay.listLinks()).find((item) => item.id === link.id);
  assert.equal(mine?.lastError, reason);
  const friendLink = await (await call(relay, "/gift/link", token)).text();
  const friendJob = await (await call(relay, `/gift/jobs/${id}`, token)).text();
  for (const body of [friendLink, friendJob]) {
    assert.equal(body.includes("qwen3vl"), false);
    assert.equal(body.includes("lastError"), false);
  }
});
