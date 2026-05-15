import path from "node:path";
import { ensureDir, readJson, writeJson } from "../utils/fs.js";
import { SPECIFYR_DIR } from "./constants.js";

// Default order for projects without an explicit workflow (back-compat with pre-workflow data).
// Workflow-aware callers should pass their own `stepIds` array to listSteps/markDownstreamStale.
export const STEP_ORDER = ["constitution", "specify", "plan", "tasks", "implement"];

export const STEP_STATUSES = ["untouched", "in_progress", "complete", "stale"];

function defaultStepState(stepId) {
  return {
    id: stepId,
    status: "untouched",
    lastSessionId: null,
    staleSince: null,
    staleReason: null,
    updatedAt: new Date().toISOString()
  };
}

export class StepStateStore {
  constructor(cwd = process.cwd()) {
    this.rootDir = path.join(cwd, SPECIFYR_DIR);
  }

  stepFilePath(orgId, slug, stepId) {
    return path.join(this.rootDir, orgId, slug, "steps", `${stepId}.json`);
  }

  async getStep(orgId, slug, stepId) {
    const saved = await readJson(this.stepFilePath(orgId, slug, stepId), null);
    return saved ?? defaultStepState(stepId);
  }

  async listSteps(orgId, slug, stepIds = STEP_ORDER) {
    const results = [];
    for (const stepId of stepIds) {
      results.push(await this.getStep(orgId, slug, stepId));
    }
    return results;
  }

  async saveStep(orgId, slug, state) {
    const filePath = this.stepFilePath(orgId, slug, state.id);
    await ensureDir(path.dirname(filePath));
    const updated = { ...state, updatedAt: new Date().toISOString() };
    await writeJson(filePath, updated);
    return updated;
  }

  async setStatus(orgId, slug, stepId, status, extra = {}) {
    if (!STEP_STATUSES.includes(status)) {
      throw new Error(`Unknown step status: ${status}`);
    }
    const current = await this.getStep(orgId, slug, stepId);
    const next = { ...current, ...extra, status };
    if (status !== "stale") {
      next.staleSince = null;
      next.staleReason = null;
    }
    return this.saveStep(orgId, slug, next);
  }

  async markComplete(orgId, slug, stepId, sessionId) {
    return this.setStatus(orgId, slug, stepId, "complete", { lastSessionId: sessionId });
  }

  async markInProgress(orgId, slug, stepId, sessionId) {
    const current = await this.getStep(orgId, slug, stepId);
    if (current.status === "complete") {
      // moving back into iteration should keep complete; we use in_progress only for untouched → running
      return current;
    }
    return this.setStatus(orgId, slug, stepId, "in_progress", { lastSessionId: sessionId });
  }

  async markDownstreamStale(orgId, slug, fromStepId, reason, stepIds = STEP_ORDER) {
    const fromIdx = stepIds.indexOf(fromStepId);
    if (fromIdx === -1) return;

    const now = new Date().toISOString();
    const affected = [];
    for (let i = fromIdx + 1; i < stepIds.length; i++) {
      const downstreamId = stepIds[i];
      const state = await this.getStep(orgId, slug, downstreamId);
      if (state.status === "complete") {
        const next = {
          ...state,
          status: "stale",
          staleSince: now,
          staleReason: reason ?? `${fromStepId} was updated after completion.`
        };
        await this.saveStep(orgId, slug, next);
        affected.push(downstreamId);
      }
    }
    return affected;
  }
}
