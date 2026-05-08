import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { orgInvites, orgs } from "../../db/schema";
import { parseParams, tokenParam } from "@su/validation";

export default defineEventHandler(async (event) => {
  const { token } = parseParams(event, tokenParam);

  const db = getDb();
  if (!db) throw createError({ statusCode: 503, statusMessage: "DB not configured" });

  const [row] = await db
    .select({
      invitedEmail: orgInvites.invitedEmail,
      invitedRole: orgInvites.invitedRole,
      expiresAt: orgInvites.expiresAt,
      acceptedAt: orgInvites.acceptedAt,
      revokedAt: orgInvites.revokedAt,
      orgName: orgs.name,
      orgSlug: orgs.slug,
    })
    .from(orgInvites)
    .innerJoin(orgs, eq(orgs.id, orgInvites.orgId))
    .where(eq(orgInvites.token, token))
    .limit(1);

  if (!row) throw createError({ statusCode: 404, statusMessage: "invite not found" });

  return {
    orgName: row.orgName,
    orgSlug: row.orgSlug,
    invitedEmail: row.invitedEmail,
    invitedRole: row.invitedRole,
    expiresAt: row.expiresAt,
    status: row.revokedAt
      ? ("revoked" as const)
      : row.acceptedAt
        ? ("accepted" as const)
        : row.expiresAt.getTime() < Date.now()
          ? ("expired" as const)
          : ("pending" as const),
  };
});
