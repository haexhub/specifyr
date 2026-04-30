import { createOrchestrator } from "#su/orchestrator";

export default defineEventHandler(async () => {
  const orchestrator = await createOrchestrator();
  return orchestrator.listProjects();
});
