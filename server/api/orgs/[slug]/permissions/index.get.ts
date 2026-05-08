import { requireOrgAdmin } from "@su/org-auth";
import { listPermissions } from "@su/org-permissions-store";

/**
 * List all permission grants in this org. Admin only — the grant
 * matrix is sensitive enough that ordinary members shouldn't see it.
 * (Members can still discover what they themselves can do via the
 * 403/200 response of the actual write endpoints.)
 */
export default defineEventHandler(async (event) => {
  const { org } = await requireOrgAdmin(event);
  const permissions = await listPermissions(org.id);
  return { permissions };
});
