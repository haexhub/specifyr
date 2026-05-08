import { z } from "zod";
import { requireOrgMembership } from "@su/org-auth";
import { transferOrgOwnership } from "@su/org-store";
import { parseBody } from "@su/validation";

const transferSchema = z.object({
  newOwnerUserId: z.uuid(),
});

/**
 * Transfer org ownership. Caller must be the current owner — admin
 * isn't sufficient. The new owner must already be a member.
 *
 * Atomic: org.owner_user_id is swapped, both old and new owner end up
 * with role='admin'. After success, the old owner is no longer pinned
 * and can be removed/demoted via the normal member endpoints.
 */
export default defineEventHandler(async (event) => {
  const { userId, org } = await requireOrgMembership(event);
  if (org.ownerUserId !== userId) {
    throw createError({
      statusCode: 403,
      statusMessage: "only the current owner can transfer ownership",
    });
  }

  const { newOwnerUserId } = await parseBody(event, transferSchema);

  const result = await transferOrgOwnership(org.id, newOwnerUserId);
  if (!result.ok) {
    if (result.reason === "not_member") {
      throw createError({
        statusCode: 400,
        statusMessage: "new owner must already be a member of the org",
      });
    }
    if (result.reason === "same_owner") {
      throw createError({
        statusCode: 400,
        statusMessage: "already the owner",
      });
    }
  }

  return { ok: true, newOwnerUserId };
});
