/**
 * Supervisor — deterministic watchdog for company-runtime dispatches.
 *
 * Reads runtime events (dispatch-started / dispatched / dispatch-error) to
 * track which dispatches are currently in-flight. On each tick, checks
 * whether any pending dispatch has exceeded its SLA without a completion
 * event. If yes:
 *   1. Appends an `agent-stuck` event to the JSONL log.
 *   2. Writes a structured intervention ticket into queue-ceo so the CEO
 *      LLM can investigate (kill container? redispatch? escalate to user?).
 *
 * Architecture decisions (see architecture_decisions.md §1):
 *   - Detection is deterministic code, NOT LLM. LLM cost stays bounded
 *     to genuine escalations.
 *   - Tracking via in-memory pending state from EventEmitter subscription.
 *     We do NOT replay the JSONL log — that's the audit/UI/replay path
 *     (10b/13), not the liveness path.
 *   - Per-agent SLA via `agent.sla_seconds` in the spec, default 1h.
 *   - One alert per stuck dispatch — once flagged, we don't re-emit until
 *     it either completes or the runtime restarts.
 *
 * Test seams:
 *   - `clock`  : () => millis since epoch. Default Date.now.
 *   - `tick()` : public method tests call directly to drive a check cycle
 *                deterministically; production uses setInterval(tick).
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { buildTaskId } from "./mcp-dispatch.js";

const DEFAULT_SLA_MS = 60 * 60 * 1000;        // 1 hour
const DEFAULT_INTERVAL_MS = 30 * 1000;        // 30 seconds

export class Supervisor {
  /**
   * @param {object} opts
   * @param {EventEmitter & {slug, ceoRole, getAgent, getRoleQueueDir}} opts.runtime
   * @param {{append: (evt: object) => Promise<any>}} opts.eventLog
   * @param {number} [opts.intervalMs]
   * @param {number} [opts.defaultSlaMs]
   * @param {() => number} [opts.clock]
   */
  constructor({
    runtime,
    eventLog,
    intervalMs = DEFAULT_INTERVAL_MS,
    defaultSlaMs = DEFAULT_SLA_MS,
    clock = () => Date.now(),
  } = {}) {
    if (!runtime) throw new Error("Supervisor: runtime required");
    if (!eventLog) throw new Error("Supervisor: eventLog required");
    this.runtime = runtime;
    this.eventLog = eventLog;
    this.intervalMs = intervalMs;
    this.defaultSlaMs = defaultSlaMs;
    this.clock = clock;
    this._pending = new Map();    // path -> { role, startedAt, alerted }
    this._timer = null;
    this._listeners = null;
  }

  start() {
    if (this._listeners) return; // idempotent
    const onStarted = (evt) => {
      this._pending.set(evt.path, {
        role: evt.role,
        startedAt: this.clock(),
        alerted: false,
      });
    };
    const onDone = (evt) => {
      this._pending.delete(evt.path);
    };
    this.runtime.on("dispatch-started", onStarted);
    this.runtime.on("dispatched", onDone);
    this.runtime.on("dispatch-error", onDone);
    this._listeners = { onStarted, onDone };

    if (this.intervalMs > 0) {
      this._timer = setInterval(() => {
        this.tick().catch(() => {
          // Errors during tick must not crash the runtime. The Supervisor
          // is best-effort; a failing append or writeFile is logged via
          // the event itself if possible, otherwise swallowed. Production
          // can layer a logger here later.
        });
      }, this.intervalMs);
      // Don't keep the process alive just for the supervisor — the
      // QueuePoller's chokidar watcher already does that when active.
      this._timer.unref?.();
    }
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._listeners) {
      this.runtime.off("dispatch-started", this._listeners.onStarted);
      this.runtime.off("dispatched", this._listeners.onDone);
      this.runtime.off("dispatch-error", this._listeners.onDone);
      this._listeners = null;
    }
    this._pending.clear();
  }

  /**
   * One detection cycle. Public so tests can drive it deterministically
   * without waiting for setInterval. Production calls happen automatically
   * from the start()-installed timer.
   */
  async tick() {
    const now = this.clock();
    for (const [taskPath, info] of this._pending) {
      if (info.alerted) continue;
      const sla = this._slaFor(info.role);
      if (now - info.startedAt <= sla) continue;
      info.alerted = true;
      await this._escalate(taskPath, info, now);
    }
  }

  _slaFor(role) {
    const agent = this.runtime.getAgent?.(role);
    if (typeof agent?.sla_seconds === "number" && agent.sla_seconds > 0) {
      return agent.sla_seconds * 1000;
    }
    return this.defaultSlaMs;
  }

  async _escalate(taskPath, info, now) {
    const stuckForMs = now - info.startedAt;
    await this.eventLog.append({
      type: "agent-stuck",
      slug: this.runtime.slug,
      role: info.role,
      task_path: taskPath,
      stuck_for_ms: stuckForMs,
    });

    const queueCeo = this.runtime.getRoleQueueDir?.(this.runtime.ceoRole);
    if (!queueCeo) return; // no CEO queue → nowhere to escalate; agent-stuck event in log is the audit
    const taskId = buildTaskId();
    const yaml = stringifyYaml({
      title: `Stuck: ${info.role} ohne Completion seit ${Math.round(stuckForMs / 1000)}s`,
      goal: `Untersuche '${info.role}' (task: ${taskPath}). Container check, Logs prüfen, ggf. redispatchen oder eskalieren.`,
      source: "supervisor",
      intervention: {
        kind: "agent-stuck",
        stuck_role: info.role,
        stuck_task_path: taskPath,
        stuck_for_ms: stuckForMs,
      },
    });
    await writeFile(path.join(queueCeo, `${taskId}.yaml`), yaml, "utf8");
  }
}
