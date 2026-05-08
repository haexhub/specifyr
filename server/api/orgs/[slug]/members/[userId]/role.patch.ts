import { requireOrgAdmin } from "@su/org-auth";
import { updateMembershipRole } from "@su/org-store";

/**
 * Promote/demote an org member. Caller must be admin (and the org's
 * owner counts as admin even if no membership row says so — but they
 * always have one because createOrgWithAdmin inserts it).
 *
 * Guards:
 *   - 400 owner_immutable: cannot demote `org.owner_user_id`.
 *   - 400 would_orphan_admins: cannot demote the last admin.
 *   - 404 not_member: target isn't in this org.
 *
 * Idempotent — patching to the same role is a 200 no-op.
 */
export default defineEventHandler(async (event) => {
  const { org } = await requireOrgAdmin(event);
  const targetUserId = getRouterParam(event, "userId");
  if (!targetUserId) {
    throw createError({ statusCode: 400, statusMessage: "userId required" });
  }
  const body = await readBody<{ role?: string }>(event);
  const role = body?.role;
  if (role !== "admin" && role !== "member") {
    throw createError({
      statusCode: 400,
      statusMessage: "role must be 'admin' or 'member'",
    });
  }

  const result = await updateMembershipRole(org.id, targetUserId, role);
  if (!result.ok) {
    if (result.reason === "not_member") {
      throw createError({ statusCode: 404, statusMessage: "not a member" });
    }
    if (result.reason === "owner_immutable") {
      throw createError({
        statusCode: 400,
        statusMessage: "owner stays admin (transfer ownership first)",
      });
    }
    if (result.reason === "would_orphan_admins") {
      throw createError({
        statusCode: 400,
        statusMessage:
          "cannot demote the last admin — promote someone else first",
      });
    }
  }

  return { ok: true, role };
});
