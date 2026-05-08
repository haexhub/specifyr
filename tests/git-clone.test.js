/**
 * URL-validation tests for git-clone util. We don't exercise the actual
 * `git clone` against real network — that would couple CI to GitHub —
 * we just verify the safety guards (URL allowlist, host blocks).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

test("rejects non-https URLs", async () => {
  const { gitClone } = await import("../server/utils/git-clone.ts");
  for (const url of [
    "http://example.com/repo.git",
    "git://example.com/repo.git",
    "ssh://git@example.com/repo.git",
    "file:///etc/passwd",
  ]) {
    const r = await gitClone({ url, destination: "/tmp/never" });
    assert.equal(r.ok, false, `expected ${url} rejected`);
    assert.match(r.stderr, /https/, `expected https rejection for ${url}`);
  }
});

test("rejects loopback / link-local hosts", async () => {
  const { gitClone } = await import("../server/utils/git-clone.ts");
  for (const url of [
    "https://localhost/repo.git",
    "https://127.0.0.1/repo.git",
    "https://[::1]/repo.git",
    "https://169.254.169.254/repo.git",
  ]) {
    const r = await gitClone({ url, destination: "/tmp/never" });
    assert.equal(r.ok, false, `expected ${url} rejected`);
    assert.match(r.stderr, /not allowed|invalid URL/, `expected host block for ${url}`);
  }
});

test("rejects malformed URLs", async () => {
  const { gitClone } = await import("../server/utils/git-clone.ts");
  const r = await gitClone({ url: "not a url", destination: "/tmp/never" });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /invalid URL/);
});
