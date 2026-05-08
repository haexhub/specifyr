import { z } from "zod";
import { requireOrgAdmin } from "@su/org-auth";
import { grantPermission } from "@su/org-permissions-store";
import { getMembership } from "@su/org-store";
import { orgMemberParams, parseBody, parseParams } from "@su/validation";

const bodySchema = z.object({
  permission: z.enum(["manage_extensions"]),
});

/**
 * Grant a permission to a member of this org. Admin only. Idempotent.
 * Returns 404 if `userId` is not a member of the org.
 */
export default defineEventHandler(async (event) => {
  const { org, userId: grantorUserId } = await requireOrgAdmin(event);
  const { userId: targetUserId } = parseParams(event, orgMemberParams);
  const { permission } = await parseBody(event, bodySchema);

  // Verify the target is a member before granting; the store also
  // guards but we want a clean 404 instead of a thrown Error.
  const member = await getMembership(org.id, targetUserId);
  if (!member) {
    throw createError({ statusCode: 404, statusMessage: "user is not a member of this org" });
  }

  const grant = await grantPermission({
    orgId: org.id,
    userId: targetUserId,
    permission,
    grantedBy: grantorUserId,
  });
  return { grant };
});
