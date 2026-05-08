import { requireOrgAdmin } from "@su/org-auth";
import { removeMembership } from "@su/org-store";
import { orgMemberParams, parseParams } from "@su/validation";

/**
 * Remove an org member. Caller must be admin.
 *
 * Guards:
 *   - 400 owner_immutable: cannot remove `org.owner_user_id` —
 *     transfer ownership first.
 *   - 400 would_orphan_admins: cannot remove the last admin.
 *   - 404 not_member: target isn't in this org.
 *
 * Self-removal IS allowed when the caller is not the owner and the
 * org has another admin to take over. The UI typically routes "leave
 * org" to this endpoint with the caller's own userId.
 */
export default defineEventHandler(async (event) => {
  const { org } = await requireOrgAdmin(event);
  const { userId: targetUserId } = parseParams(event, orgMemberParams);

  const result = await removeMembership(org.id, targetUserId);
  if (!result.ok) {
    if (result.reason === "not_member") {
      throw createError({ statusCode: 404, statusMessage: "not a member" });
    }
    if (result.reason === "owner_immutable") {
      throw createError({
        statusCode: 400,
        statusMessage:
          "owner cannot be removed; transfer ownership first",
      });
    }
    if (result.reason === "would_orphan_admins") {
      throw createError({
        statusCode: 400,
        statusMessage:
          "cannot remove the last admin — promote someone else first",
      });
    }
  }

  return { ok: true };
});
