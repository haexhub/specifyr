import { requireOrgAdmin } from "@su/org-auth";
import { revokePermission } from "@su/org-permissions-store";
import { orgPermissionParams, parseParams } from "@su/validation";

/**
 * Revoke a single permission from a member. Admin only. Idempotent —
 * revoking a non-existent grant returns 200 (the post-condition holds
 * either way).
 */
export default defineEventHandler(async (event) => {
  const { org } = await requireOrgAdmin(event);
  const { userId, permission } = parseParams(event, orgPermissionParams);
  await revokePermission(org.id, userId, permission);
  return { ok: true };
});
