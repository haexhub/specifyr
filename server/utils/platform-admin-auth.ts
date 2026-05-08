import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { users } from "../db/schema";

/**
 * Asserts the request comes from an authenticated platform admin.
 * Throws 401 / 403 / 503 as appropriate; returns the user id on
 * success so handlers can chain authoring metadata (e.g. set
 * `updated_by_user_id` on a settings PATCH).
 */
export async function requirePlatformAdmin(event: any): Promise<string> {
  const userId = event.context.userId as string | undefined;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }
  const db = getDb();
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: "DB not configured" });
  }
  const [row] = await db
    .select({ isPlatformAdmin: users.isPlatformAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row?.isPlatformAdmin) {
    throw createError({ statusCode: 403, statusMessage: "platform admin only" });
  }
  return userId;
}
