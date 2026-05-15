import { createOrchestrator } from "@su/orchestrator";
import { canUserAccessProject } from "@su/project-store";

/**
 * Lists projects within the org identified by the URL.
 *
 * Auth (enforced by project-access middleware):
 *   - caller must be a member of :orgSlug
 *
 * Filtering:
 *   - org admins see every project in the org
 *   - org members see only projects they have an explicit
 *     project_memberships row for
 */
export default defineEventHandler(async (event) => {
  const userId = event.context.userId!;
  const orgId = event.context.orgId!;
  const orgSlug = event.context.orgSlug!;
  const orgRole = event.context.orgRole;

  const orchestrator = await createOrchestrator();
  const all = await orchestrator.listProjects();
  const orgProjects = (all as Array<{ orgId: string; slug: string }>)
    .filter((p) => p.orgId === orgId);

  if (orgRole === "admin") {
    return orgProjects.map((p) => ({ ...p, orgSlug }));
  }

  const visible: typeof orgProjects = [];
  for (const p of orgProjects) {
    if (await canUserAccessProject(orgId, p.slug, userId)) {
      visible.push(p);
    }
  }
  return visible.map((p) => ({ ...p, orgSlug }));
});
