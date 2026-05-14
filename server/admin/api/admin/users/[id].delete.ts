import { count, eq } from "drizzle-orm";
import { getDb } from "@db/client";
import { orgs, users } from "@db/schema";
import { requirePlatformAdmin } from "@su/platform-admin-auth";
import { idUuidParam, parseParams } from "@su/validation";

/**
 * Permanently delete a user. Memberships and runner sessions cascade
 * automatically (see schema FKs). Fails with 409 if the user still owns
 * an org — the `orgs.owner_user_id` FK is `restrict`, so ownership must
 * be transferred (or the org deleted) first.
 *
 * Platform admin only. Cannot delete self.
 */
export default defineEventHandler(async (event) => {
  const adminId = await requirePlatformAdmin(event);
  const { id } = parseParams(event, idUuidParam);

  if (id === adminId) {
    throw createError({
      statusCode: 400,
      statusMessage: "cannot delete yourself",
    });
  }

  const db = getDb();
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: "DB not configured" });
  }

  const [{ ownedOrgs } = { ownedOrgs: 0 }] = await db
    .select({ ownedOrgs: count() })
    .from(orgs)
    .where(eq(orgs.ownerUserId, id));

  if (Number(ownedOrgs) > 0) {
    throw createError({
      statusCode: 409,
      statusMessage: `user owns ${ownedOrgs} org(s); transfer ownership before deleting`,
    });
  }

  const [deleted] = await db
    .delete(users)
    .where(eq(users.id, id))
    .returning({ id: users.id });

  if (!deleted) {
    throw createError({ statusCode: 404, statusMessage: "user not found" });
  }

  return { ok: true };
});
