import { eq } from "drizzle-orm";
import { getDb } from "@db/client";
import { users } from "@db/schema";
import { listOrgsForUser } from "@su/org-store";

/**
 * Returns the authenticated user's profile + their org memberships.
 * Mandatory-org model: an empty `memberships[]` triggers the
 * onboarding redirect on the client (force-create-org). The caller's
 * `isPlatformAdmin` flag is used by the admin route guard.
 */
export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }

  const db = getDb();
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: "DB not configured" });
  }

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      isPlatformAdmin: users.isPlatformAdmin,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw createError({ statusCode: 404, statusMessage: "user not found" });
  }

  const orgs = await listOrgsForUser(userId);
  const memberships = orgs.map((o) => ({
    orgId: o.id,
    orgSlug: o.slug,
    orgName: o.name,
    role: o.role,
    isOwner: o.ownerUserId === userId,
  }));

  return {
    ...user,
    memberships,
  };
});
