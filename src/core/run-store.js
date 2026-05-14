import path from "node:path";
import { readJson, writeJson, readText, writeText, ensureDir } from "../utils/fs.js";
import { SPECIFYR_DIR } from "./constants.js";

/**
 * Persistence for the Implement run.
 *
 * Directory layout under `.specifyr/<orgId>/<slug>/run/`:
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

function runDir(cwd, orgId, slug) {
  return path.join(cwd, SPECIFYR_DIR, orgId, slug, "run");
}
function currentPath(cwd, orgId, slug) {
  return path.join(runDir(cwd, orgId, slug), "current.json");
}
function taskLogPath(cwd, orgId, slug, taskId) {
  return path.join(runDir(cwd, orgId, slug), "tasks", `${taskId}.log`);
}

export class RunStore {
  constructor(cwd = process.cwd()) {
    this.cwd = cwd;
  }

  async getCurrent(orgId, slug) {
    return readJson(currentPath(this.cwd, orgId, slug), null);
  }

  async saveCurrent(orgId, slug, state) {
    const filePath = currentPath(this.cwd, orgId, slug);
    await ensureDir(path.dirname(filePath));
    const next = { ...state, updatedAt: new Date().toISOString() };
    await writeJson(filePath, next);
    return next;
  }

  async initFromGraph(orgId, slug, graph) {
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
    return this.saveCurrent(orgId, slug, state);
  }

  async appendTaskLog(orgId, slug, taskId, entry) {
    const filePath = taskLogPath(this.cwd, orgId, slug, taskId);
    await ensureDir(path.dirname(filePath));
    const current = await readText(filePath, "");
    const line = JSON.stringify({ ...entry, ts: entry.ts ?? new Date().toISOString() });
    await writeText(filePath, `${current}${line}\n`);
  }

  async readTaskLog(orgId, slug, taskId) {
    const filePath = taskLogPath(this.cwd, orgId, slug, taskId);
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

  async setTaskStatus(orgId, slug, taskId, patch) {
    const state = await this.getCurrent(orgId, slug);
    if (!state) throw new Error(`No run state for ${slug}`);
    const existing = state.tasks[taskId];
    if (!existing) throw new Error(`Task ${taskId} not in run state`);
    state.tasks[taskId] = { ...existing, ...patch };
    await this.saveCurrent(orgId, slug, state);
    return state.tasks[taskId];
  }

  async setRunStatus(orgId, slug, patch) {
    const state = await this.getCurrent(orgId, slug);
    if (!state) throw new Error(`No run state for ${slug}`);
    const merged = { ...state, ...patch };
    await this.saveCurrent(orgId, slug, merged);
    return merged;
  }
}
