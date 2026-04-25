import { createOrchestrator } from "../../utils/orchestrator";
import { getProjectWorkflowId } from "../../utils/workflows";
import { getProjectWorkflow } from "../../utils/workflow-discovery";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  const orchestrator = await createOrchestrator();

  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }

  try {
    const snapshot = await orchestrator.projectSnapshot(slug);
    // Enrich with workflow: id (from meta) + full definition (steps etc.). The client uses
    // this directly instead of fetching a separate workflow endpoint.
    const workflowId = await getProjectWorkflowId(slug);
    const workflow = await getProjectWorkflow(slug, workflowId);
    return { ...snapshot, workflow: workflowId, workflowDefinition: workflow };
  } catch (error) {
    throw createError({
      statusCode: 404,
      statusMessage: error instanceof Error ? error.message : "Project not found"
    });
  }
});
