/**
 * Auto-push debounce: rapid triggers within the window collapse to a
 * single push; no-op when no repository is configured; errors are
 * logged but never thrown (background task must not crash the
 * triggering request).
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let tmpDataDir: string;
let originalDataDir: string | undefined;
let originalSecretKey: string | undefined;

before(async () => {
  tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "specifyr-autosync-"));
  originalDataDir = process.env.SPECIFYR_DATA_DIR;
  originalSecretKey = process.env.SPECIFYR_SECRET_KEY;
  process.env.SPECIFYR_DATA_DIR = tmpDataDir;
  process.env.SPECIFYR_PROJECTS_DIR = path.join(tmpDataDir, "projects");
  process.env.SPECIFYR_SECRET_KEY = crypto.randomBytes(32).toString("hex");
});

after(async () => {
  if (originalDataDir === undefined) delete process.env.SPECIFYR_DATA_DIR;
  else process.env.SPECIFYR_DATA_DIR = originalDataDir;
  if (originalSecretKey === undefined) delete process.env.SPECIFYR_SECRET_KEY;
  else process.env.SPECIFYR_SECRET_KEY = originalSecretKey;
  delete process.env.SPECIFYR_PROJECTS_DIR;
  await fs.rm(tmpDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const metaDir = path.join(tmpDataDir, ".specifyr", "autosync-test");
  await fs.rm(metaDir, { recursive: true, force: true });
  await fs.mkdir(metaDir, { recursive: true });
  await fs.writeFile(
    path.join(metaDir, "meta.json"),
    JSON.stringify({ description: "x", workflow: "spec-kit" }, null, 2),
  );
});

test("triggerAutoPush is a no-op when repository is not configured", async () => {
  const mod = await import(
    "../../server/shared/utils/repository-autosync.ts"
  );
  let calls = 0;
  const result = await mod.triggerAutoPushImmediate("autosync-test", {
    push: async () => {
      calls++;
      return { ok: true, pushed: true, stderr: "" };
    },
  });
  assert.equal(result.skipped, true);
  assert.equal(calls, 0);
});

test("triggerAutoPushImmediate calls the injected push when repository is configured", async () => {
  const { setProjectRepository } = await import(
    "../../server/shared/utils/project-repository.ts"
  );
  const { setSecret, GIT_REMOTE_TOKEN_KEY } = await import(
    "../../server/shared/utils/secrets-store.ts"
  );
  await setProjectRepository("autosync-test", {
    url: "https://github.com/x/y.git",
    branch: "main",
    username: "u",
  });
  await setSecret("autosync-test", GIT_REMOTE_TOKEN_KEY, "t");

  const mod = await import(
    "../../server/shared/utils/repository-autosync.ts"
  );
  let calls = 0;
  const result = await mod.triggerAutoPushImmediate("autosync-test", {
    push: async () => {
      calls++;
      return { ok: true, pushed: true, stderr: "" };
    },
  });
  assert.equal(result.skipped, false);
  assert.equal(result.ok, true);
  assert.equal(result.pushed, true);
  assert.equal(calls, 1);
});

test("triggerAutoPushImmediate swallows errors from the push (logs only)", async () => {
  const { setProjectRepository } = await import(
    "../../server/shared/utils/project-repository.ts"
  );
  const { setSecret, GIT_REMOTE_TOKEN_KEY } = await import(
    "../../server/shared/utils/secrets-store.ts"
  );
  await setProjectRepository("autosync-test", {
    url: "https://github.com/x/y.git",
    branch: "main",
    username: "u",
  });
  await setSecret("autosync-test", GIT_REMOTE_TOKEN_KEY, "t");

  const mod = await import(
    "../../server/shared/utils/repository-autosync.ts"
  );
  // Must not throw despite the push throwing.
  const result = await mod.triggerAutoPushImmediate("autosync-test", {
    push: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(result.skipped, false);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /boom/);
});

test("triggerAutoPush debounces multiple rapid calls", async () => {
  const { setProjectRepository } = await import(
    "../../server/shared/utils/project-repository.ts"
  );
  const { setSecret, GIT_REMOTE_TOKEN_KEY } = await import(
    "../../server/shared/utils/secrets-store.ts"
  );
  await setProjectRepository("autosync-test", {
    url: "https://github.com/x/y.git",
    branch: "main",
    username: "u",
  });
  await setSecret("autosync-test", GIT_REMOTE_TOKEN_KEY, "t");

  const mod = await import(
    "../../server/shared/utils/repository-autosync.ts"
  );
  let calls = 0;
  // Use a tiny debounce window for the test so we don't wait 5s.
  mod.triggerAutoPush("autosync-test", {
    debounceMs: 60,
    push: async () => {
      calls++;
      return { ok: true, pushed: true, stderr: "" };
    },
  });
  mod.triggerAutoPush("autosync-test", {
    debounceMs: 60,
    push: async () => {
      calls++;
      return { ok: true, pushed: true, stderr: "" };
    },
  });
  mod.triggerAutoPush("autosync-test", {
    debounceMs: 60,
    push: async () => {
      calls++;
      return { ok: true, pushed: true, stderr: "" };
    },
  });
  // Wait for debounce + a small margin for the async push to settle.
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(calls, 1, `expected exactly one push, got ${calls}`);
});
