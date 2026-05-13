import { sql } from "drizzle-orm";
import { getDb } from "../shared/database/client";
import { parseCidr } from "../shared/utils/bridge-subnet-allocator";

const DEFAULT_POOL = "10.20.0.0/14";

/**
 * Nitro startup plugin: aborts boot if any org carries a bridge_subnet
 * outside the configured SPECIFYR_BRIDGE_POOL. Catches two failure
 * modes the allocator + migrations cannot:
 *
 *   1. The 0006 backfill is unguarded — a deployment with > pool-size
 *      pre-existing orgs would silently produce out-of-pool /24s.
 *   2. SPECIFYR_BRIDGE_POOL was shrunk between deploys, or someone hand-
 *      patched a row with an out-of-pool CIDR.
 *
 * Either way the runtime allocator stays correct (it scans only inside
 * the pool), but `docker network create --subnet=<out-of-pool>` later
 * could collide with host networks. Fail loudly so the operator widens
 * the pool / fixes the row before traffic arrives.
 *
 * Runs after `db.ts` (alphabetical filename ordering), so migrations
 * have already been applied. No-op when DATABASE_URL is unset.
 */
export default defineNitroPlugin(async () => {
  const db = getDb();
  if (!db) return;

  const pool = process.env.SPECIFYR_BRIDGE_POOL ?? DEFAULT_POOL;
  parseCidr(pool);

  const result = (await db.execute(sql`
    SELECT id::text AS id, slug, bridge_subnet::text AS subnet
    FROM orgs
    WHERE bridge_subnet IS NOT NULL
      AND NOT (bridge_subnet <<= ${pool}::cidr)
  `)) as unknown as {
    rows: Array<{ id: string; slug: string; subnet: string }>;
  };

  if (result.rows.length === 0) return;

  const summary = result.rows
    .map((r) => `  - ${r.slug} (${r.id}) → ${r.subnet}`)
    .join("\n");
  console.error(
    `[bridge-pool] ${result.rows.length} org(s) outside SPECIFYR_BRIDGE_POOL=${pool}:\n${summary}`,
  );
  throw new Error(
    `bridge_subnet integrity violation: ${result.rows.length} org(s) outside pool ${pool}`,
  );
});
