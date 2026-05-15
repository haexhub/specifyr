import { resolveWorkflow, type Workflow } from "~/utils/workflows";

interface ProjectSnapshot {
  workflow?: string;
  workflowDefinition?: Workflow;
  title?: string;
  description?: string;
  slug?: string;
  [k: string]: unknown;
}

/**
 * Fetches the project snapshot for the current route and exposes both
 * the raw response and the resolved workflow. Pages under
 * /specs/[orgSlug]/[projSlug]/* should call this instead of refetching
 * the same endpoint individually.
 */
export async function useProject() {
  const { apiBase, cacheKey } = useProjectContext();

  const { data: project, error, refresh } = await useFetch<ProjectSnapshot>(
    () => apiBase.value,
    { key: () => `project-${cacheKey.value}` },
  );

  const workflow = computed(() =>
    resolveWorkflow(
      project.value?.workflow,
      project.value?.workflowDefinition ?? null,
    ),
  );
  const workflowSteps = computed(() => workflow.value.steps);

  return { project, error, refresh, workflow, workflowSteps };
}
