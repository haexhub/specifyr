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

// ---------------------------------------------------------------------------
// append + recent
// ---------------------------------------------------------------------------

function makeIdx(dbPath) {
  const idx = new CompanyEventIndex({ dbPath });
  idx.open();
  return idx;
}

test("append: persists event with promoted columns + payload_json", async () => {
  await withTempDir(async (root) => {
    const idx = makeIdx(path.join(root, "state.db"));
    idx.append({
      id: "uuid-1",
      at: "2026-04-28T10:00:00.000Z",
      type: "dispatch-started",
      slug: "demo",
      role: "ceo",
      task_path: "/q/x.yaml",
      parent_task_id: null,
      task_title: "test",
    });
    const row = idx.db.prepare("SELECT * FROM events WHERE id = ?").get("uuid-1");
    assert.equal(row.type, "dispatch-started");
    assert.equal(row.role, "ceo");
    assert.equal(row.task_path, "/q/x.yaml");
    assert.equal(row.parent_task_id, null);
    const payload = JSON.parse(row.payload_json);
    assert.equal(payload.task_title, "test"); // un-promoted field round-trips via payload
    idx.close();
  });
});

test("append: idempotent on duplicate id (INSERT OR IGNORE)", async () => {
  await withTempDir(async (root) => {
    const idx = makeIdx(path.join(root, "state.db"));
    const evt = {
      id: "dup-1",
      at: "2026-04-28T10:00:00.000Z",
      type: "dispatch-started",
      slug: "demo",
      role: "ceo",
    };
    idx.append(evt);
    idx.append(evt); // re-replay must not crash
    const count = idx.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
    assert.equal(count, 1);
    idx.close();
  });
});

test("recent: returns events newest-first, respects limit", async () => {
  await withTempDir(async (root) => {
    const idx = makeIdx(path.join(root, "state.db"));
    for (let i = 0; i < 5; i++) {
      idx.append({
        id: `e-${i}`,
        at: `2026-04-28T10:0${i}:00.000Z`,
        type: "dispatch-started",
        slug: "demo",
        role: "dev",
      });
    }
    const rows = idx.recent({ limit: 3 });
    assert.equal(rows.length, 3);
    assert.equal(rows[0].id, "e-4"); // newest first
    assert.equal(rows[2].id, "e-2");
    idx.close();
  });
});

test("recent: filters by since timestamp", async () => {
  await withTempDir(async (root) => {
    const idx = makeIdx(path.join(root, "state.db"));
    idx.append({ id: "old", at: "2026-04-28T08:00:00.000Z", type: "x", slug: "demo" });
    idx.append({ id: "new", at: "2026-04-28T10:00:00.000Z", type: "x", slug: "demo" });
    const rows = idx.recent({ since: "2026-04-28T09:00:00.000Z" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "new");
    idx.close();
  });
});

test("recent: filters by role", async () => {
  await withTempDir(async (root) => {
    const idx = makeIdx(path.join(root, "state.db"));
    idx.append({ id: "a", at: "2026-04-28T10:00:00.000Z", type: "x", role: "ceo" });
    idx.append({ id: "b", at: "2026-04-28T10:00:01.000Z", type: "x", role: "dev" });
    const rows = idx.recent({ role: "dev" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].role, "dev");
    idx.close();
  });
});

test("pendingDispatches: lists started events without matching completion", async () => {
  await withTempDir(async (root) => {
    const idx = makeIdx(path.join(root, "state.db"));
    // Two starts, only one completion
    idx.append({ id: "s1", at: "2026-04-28T10:00:00.000Z", type: "dispatch-started", role: "ceo", task_path: "/q/done.yaml" });
    idx.append({ id: "c1", at: "2026-04-28T10:00:01.000Z", type: "dispatch-completed", role: "ceo", task_path: "/q/done.yaml" });
    idx.append({ id: "s2", at: "2026-04-28T10:00:02.000Z", type: "dispatch-started", role: "dev", task_path: "/q/stuck.yaml" });

    const pending = idx.pendingDispatches();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].task_path, "/q/stuck.yaml");
    assert.equal(pending[0].role, "dev");
    idx.close();
  });
});

test("rebuildFromDisk: replays JSONL files into a fresh db; result equals direct-append", async () => {
  await withTempDir(async (root) => {
    const eventsDir = path.join(root, "events");
    await fs.mkdir(eventsDir, { recursive: true });
    // Two files, two days, three events total
    await fs.writeFile(path.join(eventsDir, "2026-04-27.jsonl"),
      JSON.stringify({ id: "a", at: "2026-04-27T10:00:00.000Z", type: "dispatch-started", role: "ceo", task_path: "/q/a.yaml" }) + "\n");
    await fs.writeFile(path.join(eventsDir, "2026-04-28.jsonl"),
      JSON.stringify({ id: "b", at: "2026-04-28T09:00:00.000Z", type: "dispatch-completed", role: "ceo", task_path: "/q/a.yaml" }) + "\n" +
      JSON.stringify({ id: "c", at: "2026-04-28T10:00:00.000Z", type: "dispatch-started",  role: "dev", task_path: "/q/b.yaml" }) + "\n");

    const idx = new CompanyEventIndex({ dbPath: path.join(root, "state.db") });
    idx.open();
    idx.rebuildFromDisk(root);

    // Same events should now be queryable
    const all = idx.recent({ limit: 100 });
    assert.equal(all.length, 3);
    assert.equal(all[0].id, "c"); // newest first
    assert.equal(all[2].id, "a");

    // pendingDispatches reflects the unmatched start
    const pending = idx.pendingDispatches();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].task_path, "/q/b.yaml");
    idx.close();
  });
});

test("rebuildFromDisk: drop+rebuild produces identical row count to direct append", async () => {
  await withTempDir(async (root) => {
    // Build via JSONL replay, then via direct append; assert same row count.
    const eventsDir = path.join(root, "events");
    await fs.mkdir(eventsDir, { recursive: true });
    const events = [
      { id: "x1", at: "2026-04-28T10:00:00.000Z", type: "dispatch-started", role: "ceo", task_path: "/q/x.yaml" },
      { id: "x2", at: "2026-04-28T10:00:01.000Z", type: "dispatch-completed", role: "ceo", task_path: "/q/x.yaml", status: "completed" },
    ];
    await fs.writeFile(path.join(eventsDir, "2026-04-28.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const replayed = new CompanyEventIndex({ dbPath: path.join(root, "replay.db") });
    replayed.open();
    replayed.rebuildFromDisk(root);
    const replayCount = replayed.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;

    const direct = new CompanyEventIndex({ dbPath: path.join(root, "direct.db") });
    direct.open();
    for (const e of events) direct.append(e);
    const directCount = direct.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;

    assert.equal(replayCount, directCount, "rebuild + direct append must produce same row count");
    replayed.close();
    direct.close();
  });
});

test("rebuildFromDisk: idempotent — running twice doesn't duplicate rows", async () => {
  await withTempDir(async (root) => {
    const eventsDir = path.join(root, "events");
    await fs.mkdir(eventsDir, { recursive: true });
    await fs.writeFile(path.join(eventsDir, "2026-04-28.jsonl"),
      JSON.stringify({ id: "z", at: "2026-04-28T10:00:00.000Z", type: "x", slug: "demo" }) + "\n");

    const idx = new CompanyEventIndex({ dbPath: path.join(root, "state.db") });
    idx.open();
    idx.rebuildFromDisk(root);
    idx.rebuildFromDisk(root);
    idx.rebuildFromDisk(root);
    const count = idx.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
    assert.equal(count, 1, "rebuild must be idempotent (INSERT OR IGNORE on id)");
    idx.close();
  });
});

test("rebuildFromDisk: tolerates missing events/ dir (fresh project)", async () => {
  await withTempDir(async (root) => {
    const idx = new CompanyEventIndex({ dbPath: path.join(root, "state.db") });
    idx.open();
    // No events/ dir created → must not throw
    idx.rebuildFromDisk(root);
    const count = idx.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
    assert.equal(count, 0);
    idx.close();
  });
});

test("pendingDispatches: dispatch-failed and dispatch-error also count as terminal", async () => {
  await withTempDir(async (root) => {
    const idx = makeIdx(path.join(root, "state.db"));
    idx.append({ id: "s1", at: "2026-04-28T10:00:00.000Z", type: "dispatch-started", role: "ceo", task_path: "/q/a.yaml" });
    idx.append({ id: "f1", at: "2026-04-28T10:00:01.000Z", type: "dispatch-failed",  role: "ceo", task_path: "/q/a.yaml" });
    idx.append({ id: "s2", at: "2026-04-28T10:00:02.000Z", type: "dispatch-started", role: "dev", task_path: "/q/b.yaml" });
    idx.append({ id: "e2", at: "2026-04-28T10:00:03.000Z", type: "dispatch-error",   role: "dev", task_path: "/q/b.yaml" });
    const pending = idx.pendingDispatches();
    assert.equal(pending.length, 0);
    idx.close();
  });
});
