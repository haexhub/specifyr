import { count, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../db/client";
import { orgMemberships, orgs, projects, users } from "../../db/schema";
import { requirePlatformAdmin } from "@su/platform-admin-auth";
import { paginationSchema, parseQuery } from "@su/validation";

/**
 * Platform-admin: paginated list of orgs with owner email, member
 * count, and project count. Joins are done via subqueries-in-SQL to
 * keep the response shape flat.
 */
export default defineEventHandler(async (event) => {
  await requirePlatformAdmin(event);
  const db = getDb();
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: "DB not configured" });
  }

  const { limit, offset } = parseQuery(event, paginationSchema);

  const rows = await db
    .select({
      id: orgs.id,
      slug: orgs.slug,
      name: orgs.name,
      ownerUserId: orgs.ownerUserId,
      ownerEmail: users.email,
      createdAt: orgs.createdAt,
      memberCount: sql<number>`(SELECT count(*) FROM ${orgMemberships} WHERE ${orgMemberships.orgId} = ${orgs.id})`,
      projectCount: sql<number>`(SELECT count(*) FROM ${projects} WHERE ${projects.ownerOrgId} = ${orgs.id})`,
    })
    .from(orgs)
    .leftJoin(users, eq(users.id, orgs.ownerUserId))
    .orderBy(desc(orgs.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ total } = { total: 0 }] = await db
    .select({ total: count() })
    .from(orgs);

  return {
    orgs: rows,
    pagination: { limit, offset, total: Number(total) },
  };
});
