import { z } from "zod";
import { requireOrgAdmin } from "@su/org-auth";
import { updateMembershipRole } from "@su/org-store";
import { orgMemberParams, parseBody, parseParams } from "@su/validation";

const rolePatchSchema = z.object({
  role: z.enum(["admin", "member"]),
});

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
  const { userId: targetUserId } = parseParams(event, orgMemberParams);
  const { role } = await parseBody(event, rolePatchSchema);

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
