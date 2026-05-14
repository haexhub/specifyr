import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@db/client";
import { users } from "@db/schema";
import { requirePlatformAdmin } from "@su/platform-admin-auth";
import { idUuidParam, parseBody, parseParams } from "@su/validation";

const patchSchema = z.object({
  blocked: z.boolean(),
});

/**
 * Block / unblock a user. Setting `blocked: true` writes `blocked_at =
 * now()` so the auth middleware short-circuits future requests from
 * this email with 403. Setting `blocked: false` clears the flag.
 *
 * Platform admin only. Cannot target self — a blocked admin can no
 * longer reach this endpoint to unblock themselves.
 */
export default defineEventHandler(async (event) => {
  const adminId = await requirePlatformAdmin(event);
  const { id } = parseParams(event, idUuidParam);
  const { blocked } = await parseBody(event, patchSchema);

  if (id === adminId) {
    throw createError({
      statusCode: 400,
      statusMessage: "cannot block yourself",
    });
  }

  const db = getDb();
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: "DB not configured" });
  }

  const [updated] = await db
    .update(users)
    .set({
      blockedAt: blocked ? sql`now()` : null,
      updatedAt: sql`now()`,
    })
    .where(eq(users.id, id))
    .returning({
      id: users.id,
      email: users.email,
      blockedAt: users.blockedAt,
    });

  if (!updated) {
    throw createError({ statusCode: 404, statusMessage: "user not found" });
  }

  return updated;
});
