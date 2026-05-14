import { createOrchestrator } from "@su/orchestrator";
import { listProjectKeysForUser } from "@su/project-store";

export default defineEventHandler(async (event) => {
  const orchestrator = await createOrchestrator();
  const all = await orchestrator.listProjects();

  // Strict filter when the request is authenticated AND the DB is
  // configured: only projects with an ownership row matching the
  // user. An empty result is correct for first-login or pre-existing
  // FS-only projects (those have no DB row by design — see Phase 2
  // notes in the plan).
  //
  // Legacy fallback: when there's no userId (auth disabled or middleware
  // didn't attach one), return the full FS-discovered list so the
  // single-user dev/test setup keeps working.
  const userId = event.context.userId;
  if (!userId) return all;

  const ownedKeys = await listProjectKeysForUser(userId);
  const ownedSet = new Set(ownedKeys.map((k) => `${k.orgId}/${k.slug}`));
  return all.filter((p: { orgId: string; slug: string }) =>
    ownedSet.has(`${p.orgId}/${p.slug}`),
  );
});
