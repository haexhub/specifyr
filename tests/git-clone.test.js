/**
 * URL-validation tests for git-clone util. We don't exercise the actual
 * `git clone` against real network — that would couple CI to GitHub —
 * we just verify the safety guards (URL allowlist, host blocks).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

test("rejects non-https URLs", async () => {
  const { gitClone } = await import("../server/shared/utils/git-clone.ts");
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
  const { gitClone } = await import("../server/shared/utils/git-clone.ts");
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
  const { gitClone } = await import("../server/shared/utils/git-clone.ts");
  const r = await gitClone({ url: "not a url", destination: "/tmp/never" });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /invalid URL/);
});

test("rejects inline basic-auth in sourceUrl", async () => {
  const { gitClone } = await import("../server/shared/utils/git-clone.ts");
  const r = await gitClone({
    url: "https://user:token@example.com/repo.git",
    destination: "/tmp/never-creds",
  });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /inline credentials/);
});

test("rejects relative destination paths", async () => {
  const { gitClone } = await import("../server/shared/utils/git-clone.ts");
  const r = await gitClone({
    url: "https://example.com/repo.git",
    destination: "relative/path",
  });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /absolute path/);
});

test("rejects existing destination", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { gitClone } = await import("../server/shared/utils/git-clone.ts");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-clone-exists-"));
  try {
    const r = await gitClone({
      url: "https://example.com/repo.git",
      destination: dir,
    });
    assert.equal(r.ok, false);
    assert.match(r.stderr, /already exists/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("rejects DNS names that resolve to private space", async () => {
  // localhost.localhost (RFC 6761 reserved) won't resolve, but the
  // string-level localhost-suffix block catches it before DNS.
  const { gitClone } = await import("../server/shared/utils/git-clone.ts");
  const r = await gitClone({
    url: "https://my.localhost/repo.git",
    destination: "/tmp/never",
  });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /not allowed/);
});
