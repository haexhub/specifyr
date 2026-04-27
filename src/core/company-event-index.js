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
import { mkdirSync } from "node:fs";
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
}
