/**
 * CompanyEventLog — append-only per-day JSONL log of company-runtime events.
 *
 * Path layout: <baseDir>/events/YYYY-MM-DD.jsonl   (UTC date)
 *
 * Distinct from spec-kit's `EventStore` (src/core/event-store.js): different
 * concern (company-runtime vs run-orchestrator), different rotation, different
 * read-paths. Keep them separate.
 *
 * Events here are pure facts with no side-effect. The Supervisor (Inkrement
 * 10c) and the UI (Inkrement 13) read this log; nothing in 10a auto-acts on
 * an event.
 *
 * Append-atomicity: relies on POSIX atomic appends for sub-PIPE_BUF (~4 KB)
 * writes. JSON-encoded events are well below that boundary; no in-process
 * lock needed. (Same pattern as session-store.js:145.)
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class CompanyEventLog {
  /**
   * @param {object} opts
   * @param {string} opts.baseDir
   * @param {() => Date} [opts.clock]    injectable for tests
   * @param {() => string} [opts.idFn]   injectable for tests
   */
  constructor({ baseDir, clock = () => new Date(), idFn = randomUUID } = {}) {
    if (!baseDir) throw new Error("CompanyEventLog: baseDir required");
    this.baseDir = baseDir;
    this.clock = clock;
    this.idFn = idFn;
  }

  /**
   * @param {object} event   serialisable; should include `type`
   * @returns {Promise<{id: string, at: string, file: string}>}
   */
  async append(event) {
    const at = this.clock().toISOString();
    const day = at.slice(0, 10);
    const id = this.idFn();
    const enriched = { id, at, ...event };
    const file = path.join(this.baseDir, "events", `${day}.jsonl`);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(enriched)}\n`, "utf8");
    return { id, at, file };
  }
}
