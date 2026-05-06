import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { users } from "../db/schema";

/**
 * Returns the authenticated user's profile, or 401 when no user
 * resolved (auth disabled, headers missing, or DB unconfigured).
 *
 * Phase 1 endpoint — used by the frontend to know who is logged in
 * and to gate UI on the presence of a user record.
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
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw createError({ statusCode: 404, statusMessage: "user not found" });
  }

  return user;
});
