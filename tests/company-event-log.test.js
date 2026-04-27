import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CompanyEventLog } from "../src/core/company-event-log.js";

async function withTempDir(fn) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "cel-"));
  try {
    await fn(d);
  } finally {
    await fs.rm(d, { recursive: true, force: true });
  }
}

test("CompanyEventLog.append writes JSONL line into events/YYYY-MM-DD.jsonl (UTC)", async () => {
  await withTempDir(async (root) => {
    const log = new CompanyEventLog({
      baseDir: root,
      clock: () => new Date("2026-04-28T10:30:00.000Z"),
    });
    const result = await log.append({ type: "dispatch-started", role: "ceo" });

    assert.match(result.id, /^[0-9a-f-]{36}$/);
    assert.equal(result.at, "2026-04-28T10:30:00.000Z");
    assert.equal(result.file, path.join(root, "events", "2026-04-28.jsonl"));

    const content = await fs.readFile(result.file, "utf8");
    const evt = JSON.parse(content.trim());
    assert.equal(evt.type, "dispatch-started");
    assert.equal(evt.role, "ceo");
    assert.equal(evt.at, "2026-04-28T10:30:00.000Z");
  });
});

test("CompanyEventLog: multiple events on same day go to one file in order", async () => {
  await withTempDir(async (root) => {
    const log = new CompanyEventLog({
      baseDir: root,
      clock: () => new Date("2026-04-28T10:30:00.000Z"),
    });
    await log.append({ type: "a" });
    await log.append({ type: "b" });
    await log.append({ type: "c" });
    const content = await fs.readFile(path.join(root, "events", "2026-04-28.jsonl"), "utf8");
    const types = content.trim().split("\n").map((l) => JSON.parse(l).type);
    assert.deepEqual(types, ["a", "b", "c"]);
  });
});

test("CompanyEventLog: rolls to a new file when UTC date changes", async () => {
  await withTempDir(async (root) => {
    let now = new Date("2026-04-28T23:59:00.000Z");
    const log = new CompanyEventLog({ baseDir: root, clock: () => now });
    await log.append({ type: "late" });
    now = new Date("2026-04-29T00:00:30.000Z");
    await log.append({ type: "early" });

    const d28 = await fs.readFile(path.join(root, "events", "2026-04-28.jsonl"), "utf8");
    const d29 = await fs.readFile(path.join(root, "events", "2026-04-29.jsonl"), "utf8");
    assert.equal(JSON.parse(d28.trim()).type, "late");
    assert.equal(JSON.parse(d29.trim()).type, "early");
  });
});
