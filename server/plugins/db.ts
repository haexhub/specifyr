import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getDb } from "../db/client";

/**
 * Nitro startup plugin: applies pending Drizzle migrations against the
 * configured Postgres before the HTTP server starts accepting traffic.
 *
 * No-op when DATABASE_URL is unset — keeps the dev/test setup
 * runnable without postgres. Production deploys must set DATABASE_URL.
 */
export default defineNitroPlugin(async () => {
  const db = getDb();
  if (!db) {
    console.info("[db] DATABASE_URL unset, skipping migrations");
    return;
  }

  const migrationsFolder = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../db/migrations",
  );

  try {
    await migrate(db, { migrationsFolder });
    console.info("[db] migrations up-to-date");
  } catch (err) {
    // Server-start should fail loudly on schema mismatch — if the DB is
    // configured, we own its state, and silently continuing risks data
    // corruption when later code assumes a table exists.
    console.error("[db] migration failed:", err);
    throw err;
  }
});
