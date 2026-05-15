import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "@db/client";
import { orgMemberships, users } from "@db/schema";
import { addProjectMember } from "@su/project-store";
import { parseBody } from "@su/validation";

const addMemberSchema = z.object({
  userId: z.uuid().optional(),
  email: z.email().transform((e) => e.trim().toLowerCase()).optional(),
}).refine((b) => b.userId || b.email, {
  message: "must provide either userId or email",
});

/**
 * POST /api/orgs/:orgSlug/projects/:projSlug/members
 *
 * Grants a user explicit access to the project. The target must already
 * be a member of the owning org — we don't auto-invite here.
 *
 * Authorization: org admins only.
 */
export default defineEventHandler(async (event) => {
  const orgRole = event.context.orgRole;
  if (orgRole !== "admin") {
    throw createError({
      statusCode: 403,
      statusMessage: "Only org admins can manage project members.",
    });
  }
  const orgId = event.context.orgId!;
  const projectId = event.context.projectId!;
  const body = await parseBody(event, addMemberSchema);

  const db = getDb();
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: "DB not configured" });
  }

  // Resolve target to a user who is already a member of THIS org. We must
  // never distinguish "no such user" from "user exists in some other org"
  // — otherwise an admin in OrgA can enumerate every email/userId in the
  // system by toggling the response status. Both failure modes collapse
  // into the same 404.
  let targetUserId: string | undefined;
  if (body.userId) {
    const [m] = await db
      .select({ userId: orgMemberships.userId })
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.orgId, orgId),
          eq(orgMemberships.userId, body.userId),
        ),
      )
      .limit(1);
    if (!m) {
      throw createError({
        statusCode: 404,
        statusMessage: "No matching member in this org.",
      });
    }
    targetUserId = m.userId;
  } else if (body.email) {
    const [m] = await db
      .select({ userId: users.id })
      .from(users)
      .innerJoin(
        orgMemberships,
        and(
          eq(orgMemberships.userId, users.id),
          eq(orgMemberships.orgId, orgId),
        ),
      )
      .where(eq(users.email, body.email))
      .limit(1);
    if (!m) {
      throw createError({
        statusCode: 404,
        statusMessage: "No matching member in this org.",
      });
    }
    targetUserId = m.userId;
  }

  const row = await addProjectMember(projectId, targetUserId!);
  return { added: !!row, userId: targetUserId };
});
