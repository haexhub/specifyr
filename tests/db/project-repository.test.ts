/**
 * project-repository covers the per-project meta.json `repository`
 * block: get/set/clear helpers and URL validation (https only, no
 * inline credentials).
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
  tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "specifyr-repo-"));
  originalDataDir = process.env.SPECIFYR_DATA_DIR;
  originalSecretKey = process.env.SPECIFYR_SECRET_KEY;
  process.env.SPECIFYR_DATA_DIR = tmpDataDir;
  process.env.SPECIFYR_SECRET_KEY = crypto.randomBytes(32).toString("hex");
});

after(async () => {
  if (originalDataDir === undefined) delete process.env.SPECIFYR_DATA_DIR;
  else process.env.SPECIFYR_DATA_DIR = originalDataDir;
  if (originalSecretKey === undefined) delete process.env.SPECIFYR_SECRET_KEY;
  else process.env.SPECIFYR_SECRET_KEY = originalSecretKey;
  await fs.rm(tmpDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const dir = path.join(tmpDataDir, ".specifyr", "demo");
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify(
      { description: "x", workflow: "spec-kit", projectRoot: "/tmp/demo" },
      null,
      2,
    ),
  );
});

test("getProjectRepository returns null when not configured", async () => {
  const { getProjectRepository } = await import(
    "../../server/shared/utils/project-repository.ts"
  );
  assert.equal(await getProjectRepository("demo"), null);
});

test("setProjectRepository persists url + branch + username", async () => {
  const { setProjectRepository, getProjectRepository } = await import(
    "../../server/shared/utils/project-repository.ts"
  );
  await setProjectRepository("demo", {
    url: "https://github.com/acme/demo.git",
    branch: "main",
    username: "acme-bot",
  });
  const cfg = await getProjectRepository("demo");
  assert.deepEqual(cfg, {
    url: "https://github.com/acme/demo.git",
    branch: "main",
    username: "acme-bot",
  });
});

test("setProjectRepository rejects non-https url", async () => {
  const { setProjectRepository } = await import(
    "../../server/shared/utils/project-repository.ts"
  );
  await assert.rejects(
    () =>
      setProjectRepository("demo", {
        url: "git@github.com:acme/demo.git",
        branch: "main",
        username: "x",
      }),
    /https/i,
  );
});

test("setProjectRepository rejects URL with inline credentials", async () => {
  const { setProjectRepository } = await import(
    "../../server/shared/utils/project-repository.ts"
  );
  await assert.rejects(
    () =>
      setProjectRepository("demo", {
        url: "https://user:pass@github.com/acme/demo.git",
        branch: "main",
        username: "x",
      }),
    /credentials/i,
  );
});

test("clearProjectRepository removes repository key from meta", async () => {
  const { setProjectRepository, clearProjectRepository, getProjectRepository } =
    await import("../../server/shared/utils/project-repository.ts");
  await setProjectRepository("demo", {
    url: "https://example.com/y.git",
    branch: "main",
    username: "u",
  });
  await clearProjectRepository("demo");
  assert.equal(await getProjectRepository("demo"), null);
});
