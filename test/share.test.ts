import assert from "node:assert/strict";
import test from "node:test";
import {
  GITHUB_REPO,
  SITE_NAME,
  X_TEXT_LIMIT,
  displayName,
  hostOf,
  shareText,
  xShareUrl,
} from "../lib/share.ts";

test("a project without a name still has one to share", () => {
  assert.equal(displayName("   "), "Untitled project");
  assert.equal(displayName("  Night drive  "), "Night drive");
});

test("share text says what the project holds", () => {
  assert.match(shareText("Night drive", 0), /an empty canvas/);
  assert.match(shareText("Night drive", 1), /one frame/);
  assert.match(shareText("Night drive", 3), /3 frames/);
  assert.match(shareText("Night drive", 3), new RegExp(SITE_NAME));
});

test("a long name is clipped before X truncates the post", () => {
  const text = shareText("N".repeat(400), 2);
  assert.ok(text.length <= X_TEXT_LIMIT, `${text.length} > ${X_TEXT_LIMIT}`);
  assert.ok(text.endsWith("…"));
});

test("the X intent carries the post and the link, encoded", () => {
  const url = xShareUrl('“Night drive” & rain', "http://127.0.0.1:3000/p/abc?x=1");
  assert.ok(url.startsWith("https://x.com/intent/post?"));
  const params = new URL(url).searchParams;
  assert.equal(params.get("text"), '“Night drive” & rain');
  assert.equal(params.get("url"), "http://127.0.0.1:3000/p/abc?x=1");
});

test("the preview host is the URL's host", () => {
  assert.equal(hostOf("http://127.0.0.1:3000/p/abc"), "127.0.0.1:3000");
  assert.equal(hostOf("not a url"), "not a url");
});

test("the repository link is a GitHub URL", () => {
  assert.match(GITHUB_REPO.name, /^[\w.-]+\/[\w.-]+$/);
  assert.ok(GITHUB_REPO.url.startsWith("https://github.com/"));
});
