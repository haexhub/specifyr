import { EventEmitter } from "node:events";
import { ClaudeCodeRunner } from "../runners/claude-code.js";
import { HermesStreamingRunner } from "../runners/hermes-streaming.js";
import { RunStore } from "./run-store.js";
import { loadAppConfig } from "./app-config.js";

/**
 * Executes a task graph with bounded parallelism and dependency awareness.
 *
 * Strategy:
 *   - Topological dispatch: whenever a slot is free, pick the next task whose
 *     dependencies are all `completed`
 *   - Tasks marked `parallelSafe: true` can run concurrently (up to `maxParallel`)
 *   - Non-parallel-safe tasks enter "solo mode": no other task may start while
 *     they run, and they must wait for the in-flight set to drain first
 *   - On task failure, downstream tasks are transitively marked `blocked_by_upstream`
 *     and skipped; independent branches continue
 *   - User cancellation kills all in-flight runners and resolves with `paused`
 *
 * Runner selection (v1): Hermes if its binary is available, else Claude Code.
 * Per-project memory isolation for Hermes via `--memory-root` / HOME override
 * (handled inside HermesStreamingRunner).
 */

export class RunScheduler extends EventEmitter {
  constructor({
    cwd,
    slug,
    projectCwd,
    graph,
    runStore = new RunStore(cwd),
    maxParallel = 3
  } = {}) {
    super();
    this.cwd = cwd;
    this.slug = slug;
    this.projectCwd = projectCwd;
    this.graph = graph;
    this.runStore = runStore;
    this.maxParallel = Math.max(1, maxParallel);
    this.abort = false;
    this.inFlight = new Map(); // taskId -> { runner, promise }
  }

  get byId() {
    if (!this._byId) {
      this._byId = new Map(this.graph.tasks.map((t) => [t.id, t]));
    }
    return this._byId;
  }

  async pickRunner() {
    if (this._runnerFactory) return this._runnerFactory;
    const config = await loadAppConfig(this.cwd);
    const chain = config.runner?.fallbackChain ?? ["hermes", "claude"];
    for (const candidate of chain) {
      if (candidate === "hermes") {
        const available = await HermesStreamingRunner.isAvailable(config.hermes?.binary);
        if (available) {
          this._runnerFactory = (opts) =>
            new HermesStreamingRunner({
              ...opts,
              binary: config.hermes?.binary ?? "hermes",
              memoryRoot: `${this.projectCwd}/.hermes/memory`
            });
          this._runnerName = "hermes";
          return this._runnerFactory;
        }
      } else if (candidate === "claude") {
        this._runnerFactory = (opts) =>
          new ClaudeCodeRunner({
            ...opts,
            binary: config.claude?.binary ?? "claude"
          });
        this._runnerName = "claude";
        return this._runnerFactory;
      }
    }
    // Safety fallback
    this._runnerFactory = (opts) => new ClaudeCodeRunner(opts);
    this._runnerName = "claude";
    return this._runnerFactory;
  }

  get activeRunnerName() {
    return this._runnerName ?? "unknown";
  }

  async execute() {
    this.emit("run_started", { runner: this.activeRunnerName });
    await this.runStore.setRunStatus(this.slug, {
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null
    });

    const state = await this.runStore.getCurrent(this.slug);

    while (!this.abort) {
      // Launch as many tasks as the rules allow
      let launched = 0;
      while (!this.abort) {
        const next = this.pickLaunchable(state);
        if (!next) break;
        this.launchTask(next, state);
        launched += 1;
      }
      if (this.inFlight.size === 0 && launched === 0) break;
      // Wait for any in-flight to finish before re-evaluating
      if (this.inFlight.size > 0) {
        await Promise.race(Array.from(this.inFlight.values(), (x) => x.promise));
      }
    }

    // Drain any remaining in-flight (should be empty unless aborted)
    if (this.inFlight.size > 0) {
      await Promise.allSettled(Array.from(this.inFlight.values(), (x) => x.promise));
    }

    const tasks = this.graph.tasks;
    const fresh = await this.runStore.getCurrent(this.slug);
    const allDone = tasks.every((t) => {
      const s = fresh.tasks[t.id]?.status;
      return s === "completed" || s === "failed" || s === "blocked_by_upstream" || s === "skipped";
    });

    let finalStatus = "paused";
    if (!this.abort && allDone) {
      const anyFailed = tasks.some((t) => {
        const s = fresh.tasks[t.id]?.status;
        return s === "failed" || s === "blocked_by_upstream";
      });
      finalStatus = anyFailed ? "failed" : "completed";
    }

    await this.runStore.setRunStatus(this.slug, {
      status: finalStatus,
      completedAt: new Date().toISOString(),
      currentTaskId: null
    });

    if (this.abort) {
      this.emit("run_paused", {});
    } else {
      const failed = tasks.filter((t) => fresh.tasks[t.id]?.status === "failed").length;
      this.emit("run_completed", { failed, total: tasks.length });
    }
  }

  /**
   * Returns the next task that can be launched right now given the current
   * in-flight set, or null if nothing can start.
   */
  pickLaunchable(state) {
    if (this.inFlight.size >= this.maxParallel) return null;

    const anyInFlightSolo = Array.from(this.inFlight.keys()).some(
      (id) => !this.byId.get(id)?.parallelSafe
    );
    if (anyInFlightSolo) return null; // solo task must drain first

    for (const task of this.graph.tasks) {
      if (this.inFlight.has(task.id)) continue;
      const cur = state.tasks[task.id];
      if (!cur) continue;
      if (cur.status !== "pending" && cur.status !== "ready") continue;

      const deps = task.dependsOn ?? [];
      const blocked = deps.some((d) => state.tasks[d]?.status !== "completed");
      if (blocked) continue;

      // Solo rule: if task is not parallelSafe but something else is already in-flight, skip
      if (!task.parallelSafe && this.inFlight.size > 0) continue;

      return task;
    }
    return null;
  }

  launchTask(task, state) {
    const startedAt = new Date().toISOString();
    state.tasks[task.id] = {
      ...state.tasks[task.id],
      status: "running",
      startedAt
    };
    // Only the first in-flight gets to be "current" in the state pointer — harmless
    // for parallel mode, still useful for UIs that highlight "what's running now".
    if (!state.currentTaskId) state.currentTaskId = task.id;
    this.runStore.saveCurrent(this.slug, state).catch(() => {});
    this.emit("task_started", { taskId: task.id });
    this.runStore.appendTaskLog(this.slug, task.id, {
      kind: "start",
      title: task.title,
      description: task.description
    });

    const depSummaries = (task.dependsOn ?? [])
      .map((d) => this.byId.get(d))
      .filter(Boolean)
      .map((t) => `- ${t.id}: ${t.title}`);

    const prompt = [
      `You are executing a single task from a larger implementation plan.`,
      ``,
      `## Task: ${task.id} — ${task.title}`,
      task.description,
      ``,
      depSummaries.length > 0 ? `## Upstream dependencies (already completed):\n${depSummaries.join("\n")}` : "",
      ``,
      `## Execute now`,
      `Implement this task inside the current project. Create/modify files as needed.`,
      `Keep changes minimal and scoped. At the end, summarise what you did in 1–3 sentences.`
    ]
      .filter(Boolean)
      .join("\n");

    const handle = { runner: null, promise: null };
    this.inFlight.set(task.id, handle);
    const promise = (async () => {
      const factory = await this.pickRunner();
      const runner = factory({
        cwd: this.projectCwd,
        onEvent: async (ev) => {
          if (ev?.type === "assistant" && Array.isArray(ev.message?.content)) {
            for (const block of ev.message.content) {
              if (block?.type === "text" && typeof block.text === "string") {
                this.emit("task_chunk", { taskId: task.id, text: block.text });
                this.runStore.appendTaskLog(this.slug, task.id, { kind: "chunk", text: block.text });
              } else if (block?.type === "tool_use" && block.name) {
                this.emit("task_event", {
                  taskId: task.id,
                  raw: { type: "tool_use", name: block.name, input: block.input }
                });
                this.runStore.appendTaskLog(this.slug, task.id, { kind: "tool_use", name: block.name });
              }
            }
          }
          this.emit("task_event", { taskId: task.id, raw: ev });
        }
      });
      handle.runner = runner;

      try {
        const { result, claudeSessionId } = await runner.run({ prompt });
        const summary =
          (typeof result?.result === "string" && result.result.split("\n").slice(-3).join(" ").trim()) ||
          "completed";
        const fresh = await this.runStore.getCurrent(this.slug);
        fresh.tasks[task.id] = {
          ...fresh.tasks[task.id],
          status: "completed",
          completedAt: new Date().toISOString(),
          summary,
          claudeSessionId
        };
        await this.runStore.saveCurrent(this.slug, fresh);
        await this.runStore.appendTaskLog(this.slug, task.id, {
          kind: "complete",
          summary,
          claudeSessionId
        });
        this.emit("task_completed", { taskId: task.id, summary });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const fresh = await this.runStore.getCurrent(this.slug);
        fresh.tasks[task.id] = {
          ...fresh.tasks[task.id],
          status: "failed",
          completedAt: new Date().toISOString(),
          lastError: message
        };
        await this.propagateBlock(task.id, fresh);
        await this.runStore.saveCurrent(this.slug, fresh);
        await this.runStore.appendTaskLog(this.slug, task.id, { kind: "failed", error: message });
        this.emit("task_failed", { taskId: task.id, error: message });
      } finally {
        this.inFlight.delete(task.id);
      }
    })();
    handle.promise = promise;
  }

  async propagateBlock(failedId, state) {
    const fail = new Set([failedId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of this.graph.tasks) {
        if (fail.has(task.id)) continue;
        const deps = task.dependsOn ?? [];
        if (deps.some((d) => fail.has(d))) {
          fail.add(task.id);
          if (state.tasks[task.id]?.status === "pending" || state.tasks[task.id]?.status === "ready") {
            state.tasks[task.id] = {
              ...state.tasks[task.id],
              status: "blocked_by_upstream",
              lastError: `Upstream failure: ${failedId}`
            };
            this.emit("task_blocked", { taskId: task.id, upstream: failedId });
            changed = true;
          }
        }
      }
    }
  }

  cancel() {
    this.abort = true;
    for (const entry of this.inFlight.values()) {
      entry.runner?.cancel?.();
    }
  }
}
