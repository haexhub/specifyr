import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

let _pool: Pool | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

/**
 * Lazy Postgres pool. Returns null when DATABASE_URL is unset — production
 * stays single-tenant until phase 1 wires the auth middleware that needs
 * the DB. Callers should treat `getDb()` returning null as "DB not
 * configured" and degrade accordingly during the rollout.
 */
export function getDb() {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  _pool = new Pool({ connectionString: url, max: 10 });
  _db = drizzle(_pool, { schema });
  return _db;
}

export async function closeDb() {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}
