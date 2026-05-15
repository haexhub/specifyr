import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "@db/client";
import { orgMemberships, users } from "@db/schema";
import { addProjectMember } from "@su/project-store";
import { parseBody } from "@su/validation";

const addMemberSchema = z.object({
  userId: z.uuid().optional(),
  email: z.string().trim().toLowerCase().email().optional(),
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

  // Resolve userId from email if needed.
  let targetUserId = body.userId;
  if (!targetUserId && body.email) {
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);
    if (!u) {
      throw createError({ statusCode: 404, statusMessage: "user not found" });
    }
    targetUserId = u.id;
  }

  // Require the target to be an org member already.
  const [m] = await db
    .select({ orgId: orgMemberships.orgId })
    .from(orgMemberships)
    .where(
      and(
        eq(orgMemberships.orgId, orgId),
        eq(orgMemberships.userId, targetUserId!),
      ),
    )
    .limit(1);
  if (!m) {
    throw createError({
      statusCode: 400,
      statusMessage: "User must be a member of this org first.",
    });
  }

  const row = await addProjectMember(projectId, targetUserId!);
  return { added: !!row, userId: targetUserId };
});
