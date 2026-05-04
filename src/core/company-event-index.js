/**
 * CompanyEventIndex — SQLite-backed read-index over the JSONL event log.
 *
 * Per architecture_decisions.md §3+§4:
 *   - JSONL files in `<baseDir>/events/YYYY-MM-DD.jsonl` are the source of truth.
 *   - This SQLite db is a derived index: rebuild-from-disk reproduces it byte-equivalent.
 *   - Write-through pattern: every JSONL append is followed by an index.append() in
 *     the same code path. Crash between the two leaves at most a missing index row,
 *     never lost data — JSONL is the canonical source.
 *
 * Why node:sqlite: zero new dependency, Node 22+ ships it. Experimental warning
 * is cosmetic; API stabilises in Node 24 LTS. better-sqlite3 would be a drop-in
 * replacement if we ever need it (same synchronous API style).
 *
 * Schema v1:
 *   schema_version(version INTEGER)
 *   events(
 *     id TEXT PRIMARY KEY,                 -- uuid from JSONL line
 *     at TEXT NOT NULL,                    -- ISO timestamp (UTC)
 *     type TEXT NOT NULL,                  -- dispatch-started | dispatch-completed | ...
 *     slug TEXT,
 *     role TEXT,
 *     task_path TEXT,                      -- queue YAML file path; doubles as dispatch-correlation key
 *     parent_task_id TEXT,                 -- iteration chain pointer
 *     status TEXT,                         -- completion status if applicable
 *     payload_json TEXT NOT NULL           -- full event JSON for fields not promoted to columns
 *   )
 *
 * Promoted columns are the ones that filters/joins need to be fast. Everything
 * else stays in payload_json so future event types don't need migrations.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id             TEXT PRIMARY KEY,
  at             TEXT NOT NULL,
  type           TEXT NOT NULL,
  slug           TEXT,
  role           TEXT,
  task_path      TEXT,
  parent_task_id TEXT,
  status         TEXT,
  payload_json   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_at_idx        ON events(at);
CREATE INDEX IF NOT EXISTS events_type_idx      ON events(type);
CREATE INDEX IF NOT EXISTS events_role_at_idx   ON events(role, at);
CREATE INDEX IF NOT EXISTS events_task_path_idx ON events(task_path);
`;

export class CompanyEventIndex {
  /**
   * @param {object} opts
   * @param {string} opts.dbPath  absolute path to the sqlite file (created if missing)
   */
  constructor({ dbPath } = {}) {
    if (!dbPath) throw new Error("CompanyEventIndex: dbPath required");
    this.dbPath = dbPath;
    this.db = null;
  }

  open() {
    if (this.db) return;
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    // WAL is the standard choice for "many readers, one writer" use cases —
    // exactly our shape (UI/Supervisor read while CompanyRuntime writes).
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(SCHEMA_SQL);
    const existing = this.db
      .prepare("SELECT version FROM schema_version LIMIT 1")
      .get();
    if (!existing) {
      this.db
        .prepare("INSERT INTO schema_version(version) VALUES (?)")
        .run(SCHEMA_VERSION);
    }
    // Future migrations land here: detect existing.version, run upgrade SQL.
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  /**
   * Insert an event row. Idempotent on duplicate `id` (INSERT OR IGNORE) — that
   * makes rebuild-from-disk safe to re-run without dropping the table first.
   *
   * Promoted columns are extracted from `event`; everything else is preserved
   * verbatim in payload_json (including the promoted keys, so a JSON.parse on
   * payload reproduces the original event exactly).
   *
   * @param {object} event
   */
  append(event) {
    if (!this.db) throw new Error("CompanyEventIndex: open() before append()");
    if (!event?.id || !event?.at || !event?.type) {
      throw new Error("CompanyEventIndex.append: event requires id, at, type");
    }
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO events
       (id, at, type, slug, role, task_path, parent_task_id, status, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      event.id,
      event.at,
      event.type,
      event.slug ?? null,
      event.role ?? null,
      event.task_path ?? null,
      event.parent_task_id ?? null,
      event.status ?? null,
      JSON.stringify(event),
    );
  }

  /**
   * Read recent events, newest first.
   *
   * @param {object} [opts]
   * @param {number} [opts.limit=100]   max rows
   * @param {string} [opts.since]       ISO timestamp; only events with at > since
   * @param {string} [opts.role]        filter to one role
   * @returns {object[]}                event rows with payload merged back in
   */
  recent({ limit = 100, since = null, role = null } = {}) {
    if (!this.db) throw new Error("CompanyEventIndex: open() before recent()");
    const where = [];
    const params = [];
    if (since) { where.push("at > ?"); params.push(since); }
    if (role)  { where.push("role = ?"); params.push(role); }
    const sql =
      `SELECT id, at, type, slug, role, task_path, parent_task_id, status, payload_json
       FROM events
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY at DESC, id DESC
       LIMIT ?`;
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      type: r.type,
      slug: r.slug,
      role: r.role,
      task_path: r.task_path,
      parent_task_id: r.parent_task_id,
      status: r.status,
      payload: JSON.parse(r.payload_json),
    }));
  }

  /**
   * List dispatches that started but have no terminal event (-completed,
   * -failed, -error). Correlation key is `task_path` — same convention as
   * Supervisor.
   *
   * Used by future API endpoints + Supervisor warmup (when supervisor starts
   * after a runtime has been running, it can seed its in-memory state from
   * here instead of starting blind).
   */
  /**
   * Replay every JSONL line in `<baseDir>/events/*.jsonl` into the index.
   * Idempotent (INSERT OR IGNORE on id) — safe to re-run after partial replay.
   *
   * This is the **correctness contract** of the architecture: drop the db,
   * rebuild from disk, and the result is identical (same rows, same columns).
   * If you ever add a column whose value can't be derived from the JSONL,
   * you've broken files-as-truth; back out and reconsider.
   *
   * Synchronous because we use sync sqlite + sync fs APIs throughout — keeps
   * the contract simple ("rebuild() returned" = "index is consistent").
   *
   * @param {string} baseDir   the company's `.specifyr/<slug>/` dir; we read
   *                           `<baseDir>/events/*.jsonl`.
   */
  rebuildFromDisk(baseDir) {
    if (!this.db) throw new Error("CompanyEventIndex: open() before rebuildFromDisk()");
    const eventsDir = path.join(baseDir, "events");
    if (!existsSync(eventsDir)) return; // fresh project, nothing to replay
    const files = readdirSync(eventsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort(); // YYYY-MM-DD lex-sort = chronological
    for (const file of files) {
      const content = readFileSync(path.join(eventsDir, file), "utf8");
      for (const line of content.split("\n")) {
        if (!line) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          // Skip torn/malformed lines silently; JSONL append-atomicity
          // protects whole-line atomicity, but we're defensive about
          // operator-edited or partially-written files.
          continue;
        }
        if (!evt?.id || !evt?.at || !evt?.type) continue;
        this.append(evt);
      }
    }
  }

  pendingDispatches() {
    if (!this.db) throw new Error("CompanyEventIndex: open() before pendingDispatches()");
    const sql = `
      SELECT s.id, s.at, s.role, s.task_path, s.parent_task_id, s.payload_json
      FROM events s
      WHERE s.type = 'dispatch-started'
        AND NOT EXISTS (
          SELECT 1 FROM events t
          WHERE t.task_path = s.task_path
            AND t.type IN ('dispatch-completed', 'dispatch-failed', 'dispatch-error')
            AND t.at >= s.at
        )
      ORDER BY s.at ASC
    `;
    const rows = this.db.prepare(sql).all();
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      role: r.role,
      task_path: r.task_path,
      parent_task_id: r.parent_task_id,
      payload: JSON.parse(r.payload_json),
    }));
  }
}
