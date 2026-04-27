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
   * @param {{append: (evt: object) => void} | null} [opts.index]
   *        SQLite-backed read index. If provided, every JSONL append is
   *        followed by `index.append()` in the same code path (write-through
   *        per architecture_decisions.md §3). Pass `null` to disable.
   */
  constructor({
    baseDir,
    clock = () => new Date(),
    idFn = randomUUID,
    index,
  } = {}) {
    if (!baseDir) throw new Error("CompanyEventLog: baseDir required");
    this.baseDir = baseDir;
    this.clock = clock;
    this.idFn = idFn;
    // index is opt-in via constructor. Default `undefined` means
    // "no index" — caller (CompanyRuntime) wires one in. `null` is the
    // explicit "disabled" sentinel for tests.
    this.index = index ?? null;
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
    // Write-through to index. JSONL is committed at this point; index is
    // best-effort. If the SQLite write fails, the index has at most a missing
    // row, and rebuildFromDisk() reconstructs it from the canonical JSONL.
    if (this.index) {
      try {
        this.index.append(enriched);
      } catch {
        // Swallow: see contract above. A logger could surface this later.
      }
    }
    return { id, at, file };
  }
}
