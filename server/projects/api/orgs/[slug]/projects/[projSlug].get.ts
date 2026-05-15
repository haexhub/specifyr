import { createOrchestrator } from "@su/orchestrator";
import { getProjectWorkflowId } from "@su/workflows";
import { getProjectWorkflow } from "@su/workflow-discovery";

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  const orchestrator = await createOrchestrator();

  try {
    const snapshot = await orchestrator.projectSnapshot(orgId, slug);
    // Enrich with workflow: id (from meta) + full definition (steps etc.). The client uses
    // this directly instead of fetching a separate workflow endpoint.
    const workflowId = await getProjectWorkflowId(orgId, slug);
    const workflow = await getProjectWorkflow(orgId, slug, workflowId);
    return { ...snapshot, workflow: workflowId, workflowDefinition: workflow };
  } catch (error) {
    throw createError({
      statusCode: 404,
      statusMessage: error instanceof Error ? error.message : "Project not found"
    });
  }
});
