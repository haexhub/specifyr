import type { StepId, StepStatus } from "~/utils/steps";
import type { WorkflowStep } from "~/utils/workflows";
import type { StepState } from "~/types/types";

/**
 * Fetches per-step state for the current project and derives the
 * `statusMap` keyed by step id — the lookup every step-list view needs.
 *
 * Pass the workflow's steps so the map covers every known step (with
 * `undefined` for ones that have no recorded state yet) instead of only
 * the ids the server returned.
 */
export async function useStepStates(
  workflowSteps: Ref<readonly WorkflowStep[]>,
) {
  const { apiBase, cacheKey } = useProjectContext();

  const { data: stepStates, refresh } = await useFetch<StepState[]>(
    () => `${apiBase.value}/steps`,
    { default: () => [], key: () => `steps-${cacheKey.value}` },
  );

  const statusMap = computed(() => {
    const map: Record<StepId, StepStatus | undefined> = {};
    for (const step of workflowSteps.value) map[step.id] = undefined;
    for (const s of stepStates.value ?? []) map[s.id] = s.status;
    return map;
  });

  return { stepStates, statusMap, refresh };
}
