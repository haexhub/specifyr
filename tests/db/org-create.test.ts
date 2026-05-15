/**
 * End-to-end test for the extended createOrgWithAdmin path: subnet
 * allocation, per-org schema creation, and init_status default. Phase 1
 * does not generate any crypto material — the org stays in
 * 'pending_vault_init' until the Phase 3 vault flips it to 'ready'.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { skipIfNoDb, withDb, seedUser } from "../helpers/db.ts";

test(
  "createOrgWithAdmin allocates a bridge_subnet, creates the per-org schema, and leaves init_status pending",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const { createOrgWithAdmin, getOrgInitStatus } =
        await import("../../server/shared/utils/org-store.ts");
      const { orgSchemaName } = await import(
        "../../server/shared/utils/per-org-schema.ts"
      );
      const u = await seedUser();
      const org = await createOrgWithAdmin("Vault Co", u.id);

      // Bridge subnet is set + within the default pool
      assert.match(
        String((org as { bridgeSubnet: string }).bridgeSubnet),
        /^10\.\d+\.\d+\.0\/24$/,
      );

      // init_status starts as pending (Phase 3 will flip it)
      assert.equal(
        (org as { initStatus: string }).initStatus,
        "pending_vault_init",
      );

      // Per-org schema exists with the 7 vault tables
      const schema = orgSchemaName(org.id);
      const rows = (await db.execute(sql`
        SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = ${schema}
      `)) as unknown as { rows: Array<{ n: number }> };
      assert.equal(rows.rows[0]?.n, 7);

      // Helper returns the same pending state
      const status = await getOrgInitStatus(org.id);
      assert.equal(status, "pending_vault_init");
    });
  },
);

test(
  "createOrgWithAdmin: two orgs get distinct bridge_subnets",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { createOrgWithAdmin } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const a = await seedUser("a");
      const b = await seedUser("b");
      const orgA = await createOrgWithAdmin("Org A", a.id);
      const orgB = await createOrgWithAdmin("Org B", b.id);
      assert.notEqual(
        (orgA as { bridgeSubnet: string }).bridgeSubnet,
        (orgB as { bridgeSubnet: string }).bridgeSubnet,
      );
    });
  },
);

test(
  "getOrgInitStatus returns null for an unknown orgId",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { getOrgInitStatus } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const status = await getOrgInitStatus(
        "00000000-0000-0000-0000-000000000000",
      );
      assert.equal(status, null);
    });
  },
);

test(
  "getOrgInitStatus returns 'ready' after manual flip",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const { createOrgWithAdmin, getOrgInitStatus } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const u = await seedUser();
      const org = await createOrgWithAdmin("Flipped", u.id);
      // Simulate the Phase 3 vault flip
      await db.execute(sql`
        UPDATE orgs SET init_status = 'ready' WHERE id = ${org.id}::uuid
      `);
      const status = await getOrgInitStatus(org.id);
      assert.equal(status, "ready");
    });
  },
);
