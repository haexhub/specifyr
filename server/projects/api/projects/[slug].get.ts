import { createOrchestrator } from "@su/orchestrator";
import { resolveProjectOrgId } from "@su/project-store";
import { getProjectWorkflowId } from "@su/workflows";
import { getProjectWorkflow } from "@su/workflow-discovery";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  const orchestrator = await createOrchestrator();

  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }

  // TODO(phase-3): drop DB lookup once project-access middleware sets event.context.orgId.
  const orgId = await resolveProjectOrgId(slug);

  try {
    const snapshot = await orchestrator.projectSnapshot(slug);
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
