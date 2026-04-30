// StepId is a string now (was a union): different workflows define different step ids.
// Use the workflow-aware helpers in ~/lib/workflows to map ids to definitions per project.
export type StepId = string;

export type StepStatus = "untouched" | "in_progress" | "complete" | "stale";

export interface StepDefinition {
  id: StepId;
  label: string;
  command: string;
  summary: string;
  description: string;
  tips: string[];
  artifacts: string[];
  isRun?: boolean;
  runAction?: string;
}

// Backwards-compatible default: pre-workflow code reads `STEPS` and gets the built-in spec-kit
// flow. New workflow-aware code should read `project.workflowDefinition.steps` instead.
import { SPEC_KIT_WORKFLOW } from "./workflows";

export const STEPS: StepDefinition[] = SPEC_KIT_WORKFLOW.steps;

export function stepById(id: StepId, steps: StepDefinition[] = STEPS): StepDefinition {
  const step = steps.find((s) => s.id === id);
  if (!step) {
    throw new Error(`Unknown step id: ${id}`);
  }
  return step;
}

/**
 * A step is unlocked when the preceding step reached `complete` or `stale` (once done,
 * even a stale state keeps downstream accessible — the user can decide to regenerate).
 * The first step is always unlocked.
 *
 * Pass the workflow's ordered `steps` array explicitly when not using the default workflow.
 */
export function isStepUnlocked(
  stepId: StepId,
  statuses: Record<StepId, StepStatus | undefined>,
  steps: StepDefinition[] = STEPS
): boolean {
  const idx = steps.findIndex((s) => s.id === stepId);
  if (idx <= 0) return true;
  const prev = steps[idx - 1]!;
  const prevStatus = statuses[prev.id];
  return prevStatus === "complete" || prevStatus === "stale";
}
