import { getMembership, getOrgBySlug } from "@su/org-store";
import { getProjectByOrgAndSlug } from "@su/project-store";

/**
 * Resolves /api/orgs/:orgSlug/projects/:projSlug/* URLs:
 *   - 401 if unauthenticated
 *   - 404 if org or project doesn't exist
 *   - 403 if user is not a member of the org
 *   - On success: attaches { orgId, orgSlug, projectSlug } to event.context
 *
 * Skip-list: paths that don't fit the (orgSlug, projSlug) pattern bypass.
 * The route layer can rely on `event.context.orgId` being set whenever
 * the URL matches the regex — downstream handlers don't need to call
 * userOwnsProject() or resolveProjectOrgId() themselves.
 *
 * Load order: Nuxt sorts middleware alphabetically, so `auth.ts` runs
 * before `project-access.ts` — `event.context.userId` is populated by
 * the time we get here.
 */
const PROJECT_PATH_RE = /^\/api\/orgs\/([^/]+)\/projects\/([^/]+)(\/|$)/;

export default defineEventHandler(async (event) => {
  const path = event.path ?? event.node.req.url ?? "";
  const match = PROJECT_PATH_RE.exec(path);
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
  const project = await getProjectByOrgAndSlug(org.id, projSlug);
  if (!project) {
    throw createError({ statusCode: 404, statusMessage: "project not found" });
  }

  event.context.orgId = org.id;
  event.context.orgSlug = orgSlug;
  event.context.projectSlug = projSlug;
});
