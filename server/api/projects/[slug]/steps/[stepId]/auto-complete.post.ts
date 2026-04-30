import fs from "node:fs/promises";
import path from "node:path";
import {
  loadStepStateStore,
  loadEventStore,
  projectCwd,
  assertProjectExists
} from "#su/specops-stores";
import { getProjectWorkflowId } from "#su/workflows";
import { SPEC_KIT_WORKFLOW, loadInstalledExtensionWorkflow } from "#su/workflow-discovery";

/**
 * Checks whether the current step's artifact files exist in the project directory.
 * If they do (or if the step defines no artifacts), the step is auto-marked complete,
 * unlocking the next workflow step.
 *
 * Called by the client after each successful turn completes.
 */
export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  const stepId = getRouterParam(event, "stepId");
  if (!slug || !stepId) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug/stepId" });
  }

  await assertProjectExists(slug);

  const body = await readBody<{ sessionId?: string; requireArtifact?: boolean }>(event);
  // requireArtifact=true: only complete if a concrete file exists (used on page load).
  // requireArtifact=false (default): also complete steps with no artifacts after a turn.
  const requireArtifact = body?.requireArtifact === true;

  const { store } = await loadStepStateStore();
  const current = await store.getStep(slug, stepId);

  // Already complete — nothing to do.
  if (current.status === "complete") {
    return { completed: false, status: current.status };
  }

  const workflowId = await getProjectWorkflowId(slug);
  const workflow =
    workflowId === "spec-kit"
      ? SPEC_KIT_WORKFLOW
      : (await loadInstalledExtensionWorkflow(slug, workflowId)) ?? SPEC_KIT_WORKFLOW;

  const stepDef = workflow.steps.find((s) => s.id === stepId);
  const artifacts = stepDef?.artifacts ?? [];

  const projectDir = projectCwd(slug);
  const shouldComplete = artifacts.length === 0
    ? !requireArtifact // page-load: skip; post-turn: complete
    : await anyArtifactExists(projectDir, artifacts);

  if (!shouldComplete) {
    return { completed: false, status: current.status };
  }

  const updated = await store.markComplete(slug, stepId, body?.sessionId ?? null);
  const events = await loadEventStore(slug);
  await events.append({
    type: "step_auto_completed",
    level: "success",
    slug,
    stepId,
    createdAt: new Date().toISOString(),
    title: `Step '${stepId}' automatisch als erledigt markiert`
  });

  return { completed: true, status: updated.status };
});

/**
 * Returns true if at least one artifact path exists.
 * - Template paths (angle brackets): check parent dir for any files.
 * - Directory paths (no extension): check if the directory has any files.
 * - File paths: check if the file exists.
 */
async function anyArtifactExists(projectDir: string, artifacts: string[]): Promise<boolean> {
  for (const artifact of artifacts) {
    const hasPlaceholder = artifact.includes("<") || artifact.includes(">");
    const isDir = !path.extname(artifact);

    if (hasPlaceholder || isDir) {
      const dir = path.join(projectDir, hasPlaceholder ? path.dirname(artifact) : artifact);
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        if (entries.some((e) => e.isFile())) return true;
      } catch {
        // directory doesn't exist yet
      }
    } else {
      try {
        await fs.access(path.join(projectDir, artifact));
        return true;
      } catch {
        // file doesn't exist yet
      }
    }
  }
  return false;
}
