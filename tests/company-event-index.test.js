import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CompanyEventIndex } from "../src/core/company-event-index.js";

async function withTempDir(fn) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "cei-"));
  try {
    await fn(d);
  } finally {
    await fs.rm(d, { recursive: true, force: true });
  }
}

test("CompanyEventIndex: opens, migrates, closes without errors", async () => {
  await withTempDir(async (root) => {
    const dbPath = path.join(root, "state.db");
    const idx = new CompanyEventIndex({ dbPath });
    idx.open();
    idx.close();
    // db file should exist
    const stat = await fs.stat(dbPath);
    assert.ok(stat.size > 0, "db file must have schema written");
  });
});

test("CompanyEventIndex: schema_version table tracks current version", async () => {
  await withTempDir(async (root) => {
    const idx = new CompanyEventIndex({ dbPath: path.join(root, "state.db") });
    idx.open();
    const row = idx.db.prepare("SELECT version FROM schema_version LIMIT 1").get();
    assert.equal(typeof row?.version, "number");
    assert.ok(row.version >= 1);
    idx.close();
  });
});

test("CompanyEventIndex: opening twice is idempotent (migrate runs once)", async () => {
  await withTempDir(async (root) => {
    const dbPath = path.join(root, "state.db");
    const idx1 = new CompanyEventIndex({ dbPath });
    idx1.open();
    idx1.close();
    const idx2 = new CompanyEventIndex({ dbPath });
    idx2.open(); // should not crash on existing tables
    idx2.close();
  });
});
