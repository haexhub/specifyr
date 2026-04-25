import { createOrchestrator } from "../utils/orchestrator";

export default defineEventHandler(async () => {
  const orchestrator = await createOrchestrator();
  return orchestrator.listProjects();
});
