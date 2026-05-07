/**
 * Shared test helpers for DB-touching tests.
 *
 * Usage:
 *   import { skipIfNoDb, cleanDb, withDb } from "../helpers/db.ts";
 *
 *   test("...", { skip: skipIfNoDb }, async () => {
 *     await withDb(async (db) => { ... });
 *   });
 *
 * skipIfNoDb is `false` (run) when both DATABASE_URL and a usable
 * SPECIFYR_SECRET_KEY are present, otherwise a string reason. node:test
 * treats `null` as truthy → must use `false` for "don't skip".
 */

import crypto from "node:crypto";
import path from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb, closeDb } from "../../server/db/client.ts";

// SPECIFYR_SECRET_KEY is required by secrets-store.ts. Generate a stable
// per-process one if not provided so encryption tests can roundtrip.
process.env.SPECIFYR_SECRET_KEY ||= crypto.randomBytes(32).toString("hex");

export const skipIfNoDb: string | false = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL not set — skipping DB-backed test";

let _migrationsApplied = false;

/**
 * Ensures pending Drizzle migrations are applied against the test DB.
 * Idempotent across the same process — Drizzle's migrator tracks
 * applied migrations in `__drizzle_migrations` and skips them.
 *
 * Without this, tests would silently break whenever a developer adds
 * a new migration but hasn't booted `pnpm dev` since.
 */
async function ensureMigrations(): Promise<void> {
  if (_migrationsApplied) return;
  const db = getDb();
  if (!db) return;
  await migrate(db, {
    migrationsFolder: path.resolve(process.cwd(), "server/db/migrations"),
  });
  _migrationsApplied = true;
}

/**
 * TRUNCATE every test-relevant table with cascade. We run this BEFORE
 * each test rather than after so a crashed test still leaves a clean
 * slate for the next one. Order doesn't matter with CASCADE.
 *
 * Tables list is explicit (not "every table in DB") so future schemas
 * don't accidentally get blown away by a stale test setup.
 */
const TABLES = [
  "runner_sessions",
  "llm_credentials",
  "org_invites",
  "org_memberships",
  "orgs",
  "projects",
  "users",
];

export async function cleanDb(): Promise<void> {
  const db = getDb();
  if (!db) throw new Error("DB not configured");
  await ensureMigrations();
  // RESTART IDENTITY isn't needed (we use uuid defaults), CASCADE keeps
  // FKs from blocking truncate even if the explicit order missed one.
  await db.execute(sql.raw(`TRUNCATE ${TABLES.join(", ")} CASCADE`));
}

/**
 * Convenience wrapper: opens DB, cleans, runs body, closes pool. Each
 * test gets its own pool lifecycle so they're independent.
 *
 * Note: closeDb() resets the cached singleton, so subsequent calls to
 * getDb() in the same process will reopen. This matters because
 * resolver/store helpers cache nothing — they always go through getDb().
 */
export async function withDb<T>(
  body: (db: NonNullable<ReturnType<typeof getDb>>) => Promise<T>,
): Promise<T> {
  const db = getDb();
  if (!db) throw new Error("DB not configured");
  await cleanDb();
  try {
    return await body(db);
  } finally {
    await closeDb();
  }
}

/**
 * Seeds a user row keyed on a unique email. Returns the row.
 */
export async function seedUser(
  emailPrefix = "test",
): Promise<{ id: string; email: string }> {
  const db = getDb();
  if (!db) throw new Error("DB not configured");
  const { users } = await import("../../server/db/schema.ts");
  const email = `${emailPrefix}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}@local`;
  const [row] = await db.insert(users).values({ email }).returning();
  if (!row) throw new Error("user insert returned nothing");
  return { id: row.id, email: row.email };
}
