import { eq, sql } from "drizzle-orm";
import { getDb } from "@db/client";
import { users } from "@db/schema";
import { listOrgsForUser } from "@su/org-store";
import { mePatchSchema, parseBody } from "@su/validation";

/**
 * Updates the authenticated user's editable profile fields. Returns the
 * same shape as GET /api/me so the client can drop the response into
 * the existing useMe cache.
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

  const body = await parseBody(event, mePatchSchema);

  const patch: {
    displayName?: string | null;
    preferredLocale?: string | null;
    updatedAt?: ReturnType<typeof sql>;
  } = {};
  if (body.displayName !== undefined) patch.displayName = body.displayName;
  if (body.preferredLocale !== undefined) patch.preferredLocale = body.preferredLocale;

  if (Object.keys(patch).length > 0) {
    patch.updatedAt = sql`now()`;
    await db.update(users).set(patch).where(eq(users.id, userId));
  }

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      isPlatformAdmin: users.isPlatformAdmin,
      preferredLocale: users.preferredLocale,
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

  return { ...user, memberships };
});
