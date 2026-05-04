import path from "node:path";
import { readJson, writeJson, readText, writeText, ensureDir } from "../utils/fs.js";
import { SPECIFYR_DIR } from "./constants.js";

/**
 * Persistence for the Implement run.
 *
 * Directory layout under `.specifyr/<slug>/run/`:
 *   - current.json      : high-level run state (status, task statuses, pointers)
 *   - tasks/<tid>.log   : append-only per-task transcript (user prompt + assistant output)
 */

export const RUN_STATUSES = ["idle", "running", "paused", "completed", "failed"];
export const TASK_STATUSES = [
  "pending",
  "ready",
  "running",
  "completed",
  "failed",
  "blocked_by_upstream",
  "skipped"
];

function runDir(cwd, slug) {
  return path.join(cwd, SPECIFYR_DIR, slug, "run");
}
function currentPath(cwd, slug) {
  return path.join(runDir(cwd, slug), "current.json");
}
function taskLogPath(cwd, slug, taskId) {
  return path.join(runDir(cwd, slug), "tasks", `${taskId}.log`);
}

export class RunStore {
  constructor(cwd = process.cwd()) {
    this.cwd = cwd;
  }

  async getCurrent(slug) {
    return readJson(currentPath(this.cwd, slug), null);
  }

  async saveCurrent(slug, state) {
    const filePath = currentPath(this.cwd, slug);
    await ensureDir(path.dirname(filePath));
    const next = { ...state, updatedAt: new Date().toISOString() };
    await writeJson(filePath, next);
    return next;
  }

  async initFromGraph(slug, graph) {
    const tasks = {};
    for (const t of graph.tasks) {
      tasks[t.id] = {
        id: t.id,
        status: "pending",
        startedAt: null,
        completedAt: null,
        retries: 0,
        lastError: null
      };
    }
    const state = {
      slug,
      status: "idle",
      startedAt: null,
      completedAt: null,
      currentTaskId: null,
      tasks,
      generatedAt: graph.generatedAt
    };
    return this.saveCurrent(slug, state);
  }

  async appendTaskLog(slug, taskId, entry) {
    const filePath = taskLogPath(this.cwd, slug, taskId);
    await ensureDir(path.dirname(filePath));
    const current = await readText(filePath, "");
    const line = JSON.stringify({ ...entry, ts: entry.ts ?? new Date().toISOString() });
    await writeText(filePath, `${current}${line}\n`);
  }

  async readTaskLog(slug, taskId) {
    const filePath = taskLogPath(this.cwd, slug, taskId);
    const content = await readText(filePath, "");
    if (!content.trim()) return [];
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { ts: null, raw: line };
        }
      });
  }

  async setTaskStatus(slug, taskId, patch) {
    const state = await this.getCurrent(slug);
    if (!state) throw new Error(`No run state for ${slug}`);
    const existing = state.tasks[taskId];
    if (!existing) throw new Error(`Task ${taskId} not in run state`);
    state.tasks[taskId] = { ...existing, ...patch };
    await this.saveCurrent(slug, state);
    return state.tasks[taskId];
  }

  async setRunStatus(slug, patch) {
    const state = await this.getCurrent(slug);
    if (!state) throw new Error(`No run state for ${slug}`);
    const merged = { ...state, ...patch };
    await this.saveCurrent(slug, merged);
    return merged;
  }
}
