import { getMembership, getOrgBySlug } from "@su/org-store";
import {
  canUserAccessProject,
  getProjectByOrgAndSlug,
} from "@su/project-store";

/**
 * Gates two URL families and populates `event.context` for downstream handlers:
 *
 *   /api/orgs/:orgSlug/projects                          (list + create)
 *     - 401 if unauthenticated
 *     - 404 if org doesn't exist
 *     - 403 if user is not a member of the org
 *     - On success: event.context.orgId, event.context.orgSlug, event.context.orgRole
 *
 *   /api/orgs/:orgSlug/projects/:projSlug/...            (per-project routes)
 *     - 401 if unauthenticated
 *     - 404 if org or project doesn't exist
 *     - 403 if user is not a member of the org
 *     - 403 if user is not an org admin AND not a project member
 *     - On success: event.context.orgId, event.context.orgSlug, event.context.orgRole,
 *       event.context.projectSlug, event.context.projectId
 *
 * The route layer can rely on these context fields being set — downstream
 * handlers don't need to repeat the membership checks themselves.
 *
 * Load order: Nuxt sorts middleware alphabetically, so `auth.ts` runs
 * before `project-access.ts` — `event.context.userId` is populated by
 * the time we get here.
 */
const ORG_PROJECTS_RE =
  /^\/api\/orgs\/([^/]+)\/projects(?:\/([^/]+))?(?:\/|$)/;

export default defineEventHandler(async (event) => {
  const path = event.path ?? event.node.req.url ?? "";
  const match = ORG_PROJECTS_RE.exec(path);
  if (!match) return;

  const [, orgSlug, projSlug] = match;

  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }

  const org = await getOrgBySlug(orgSlug);
  if (!org) {
    throw createError({ statusCode: 404, statusMessage: "org not found" });
  }
  const membership = await getMembership(org.id, userId);
  if (!membership) {
    throw createError({
      statusCode: 403,
      statusMessage: "not a member of this org",
    });
  }

  event.context.orgId = org.id;
  event.context.orgSlug = orgSlug;
  event.context.orgRole = membership.role;

  if (!projSlug) {
    // Org-only route (list/create). Org membership is enough — the
    // handler decides whether the operation requires admin role (e.g.
    // creating a project is admin-only in the new model).
    return;
  }

  const project = await getProjectByOrgAndSlug(org.id, projSlug);
  if (!project) {
    throw createError({ statusCode: 404, statusMessage: "project not found" });
  }
  // Org admins have implicit access to every project. For non-admins,
  // require an explicit project_memberships row.
  if (membership.role !== "admin") {
    const allowed = await canUserAccessProject(org.id, projSlug, userId);
    if (!allowed) {
      throw createError({
        statusCode: 403,
        statusMessage: "no access to this project",
      });
    }
  }

  event.context.projectSlug = projSlug;
  event.context.projectId = project.id;
});
