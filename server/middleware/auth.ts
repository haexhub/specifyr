import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { users } from "../db/schema";

declare module "h3" {
  interface H3EventContext {
    /** Set when the request is authenticated AND the DB is configured. */
    userId?: string;
    userEmail?: string;
  }
}

/**
 * Auth middleware. Reads the trusted forward-auth headers Authelia
 * injects on authenticated requests (`Remote-Email`, `Remote-Name`),
 * UPSERTs a `users` row keyed on email, and attaches the user id to
 * `event.context.userId` for downstream handlers.
 *
 * Behaviour matrix:
 *   - DB unconfigured (DATABASE_URL empty)   → no-op, downstream stays
 *     in legacy single-user mode.
 *   - DB configured, no Remote-Email header  → no-op. The route layer
 *     is responsible for 401-ing if it requires auth.
 *   - DB configured, header present          → UPSERT, set context.
 *
 * Local-dev override: setting `SPECIFYR_DEV_USER_EMAIL` in the env
 * synthesises a Remote-Email header so devs can run without Authelia.
 * Production deploys MUST NOT set this env var.
 */
export default defineEventHandler(async (event) => {
  const db = getDb();
  if (!db) return;

  const headerEmail = getHeader(event, "remote-email")?.trim().toLowerCase();
  const devEmail = process.env.SPECIFYR_DEV_USER_EMAIL?.trim().toLowerCase();
  const email = headerEmail || devEmail;
  if (!email) return;

  const displayName =
    getHeader(event, "remote-name")?.trim() ||
    getHeader(event, "remote-user")?.trim() ||
    null;

  // UPSERT — insert if new, update display_name + updated_at on conflict.
  // We don't trust client to lower-case email, so we lower it ourselves
  // (Authelia already does, but devs/curl might not).
  const [row] = await db
    .insert(users)
    .values({ email, displayName })
    .onConflictDoUpdate({
      target: users.email,
      set: {
        displayName,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: users.id });

  event.context.userId = row.id;
  event.context.userEmail = email;
});
