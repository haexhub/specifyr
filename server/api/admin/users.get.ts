import { count, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../db/client";
import { orgMemberships, users } from "../../db/schema";
import { requirePlatformAdmin } from "@su/platform-admin-auth";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Platform-admin: paginated list of users, with their org-membership
 * count. The DB is the only source of truth for "who has signed in" —
 * Authentik tracks identities, but specifyr only knows about a user
 * after the auth middleware UPSERTs them.
 */
export default defineEventHandler(async (event) => {
  await requirePlatformAdmin(event);
  const db = getDb();
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: "DB not configured" });
  }

  const q = getQuery(event);
  const limit = Math.min(
    Math.max(Number.parseInt(String(q.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const offset = Math.max(Number.parseInt(String(q.offset ?? 0), 10) || 0, 0);

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      isPlatformAdmin: users.isPlatformAdmin,
      createdAt: users.createdAt,
      orgCount: sql<number>`count(${orgMemberships.orgId})`.as("org_count"),
    })
    .from(users)
    .leftJoin(orgMemberships, eq(orgMemberships.userId, users.id))
    .groupBy(users.id)
    .orderBy(desc(users.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ total } = { total: 0 }] = await db
    .select({ total: count() })
    .from(users);

  return {
    users: rows,
    pagination: { limit, offset, total: Number(total) },
  };
});
