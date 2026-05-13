/**
 * Bridge-subnet allocator tests. Pure helpers run unconditionally; the
 * concurrent + DB-backed cases skip when DATABASE_URL is unset.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { skipIfNoDb, withDb, seedUser } from "../helpers/db.ts";
import {
  allocateBridgeSubnet,
  parseCidr,
  intToIp,
} from "../../server/shared/utils/bridge-subnet-allocator.ts";

test("parseCidr normalises base IP to the prefix", () => {
  const { baseInt, prefix } = parseCidr("10.20.5.7/14");
  assert.equal(prefix, 14);
  // 10.20.0.0 / 10.21.* / 10.22.* / 10.23.* all live in 10.20.0.0/14
  assert.equal(intToIp(baseInt), "10.20.0.0");
});

test("parseCidr rejects garbage", () => {
  assert.throws(() => parseCidr("not-a-cidr"), /invalid CIDR/);
  assert.throws(() => parseCidr("10.20.0.0/33"), /invalid CIDR/);
  assert.throws(() => parseCidr("999.0.0.0/8"), /invalid CIDR/);
});

test(
  "allocator picks the first /24 when no orgs exist",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const cidr = await db.transaction(async (tx) => {
        return allocateBridgeSubnet(tx, { pool: "10.20.0.0/14" });
      });
      assert.equal(cidr, "10.20.0.0/24");
    });
  },
);

test(
  "allocator skips already-used subnets",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const u = await seedUser();
      // Insert a row with the first subnet taken
      await db.execute(sql`
        INSERT INTO orgs (slug, name, owner_user_id, bridge_subnet)
        VALUES ('pre-1', 'pre-1', ${u.id}::uuid, '10.20.0.0/24'::cidr)
      `);
      const cidr = await db.transaction(async (tx) => {
        return allocateBridgeSubnet(tx, { pool: "10.20.0.0/14" });
      });
      assert.equal(cidr, "10.20.1.0/24");
    });
  },
);

test(
  "allocator throws when pool is exhausted",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const u = await seedUser();
      // Use a /24 pool — exactly one /24 slot, occupy it
      await db.execute(sql`
        INSERT INTO orgs (slug, name, owner_user_id, bridge_subnet)
        VALUES ('full', 'full', ${u.id}::uuid, '10.99.0.0/24'::cidr)
      `);
      await assert.rejects(
        db.transaction(async (tx) => {
          return allocateBridgeSubnet(tx, { pool: "10.99.0.0/24" });
        }),
        /exhausted/,
      );
    });
  },
);

test(
  "allocator serialises concurrent calls — distinct subnets",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const u1 = await seedUser("u1");
      const u2 = await seedUser("u2");
      // Two transactions racing for an allocation. The advisory lock
      // makes them serialise; the second sees the first's row after
      // commit and picks the next slot.
      const [cidrA, cidrB] = await Promise.all([
        db.transaction(async (tx) => {
          const cidr = await allocateBridgeSubnet(tx, {
            pool: "10.20.0.0/14",
          });
          await tx.execute(sql`
            INSERT INTO orgs (slug, name, owner_user_id, bridge_subnet)
            VALUES ('a', 'a', ${u1.id}::uuid, ${cidr}::cidr)
          `);
          return cidr;
        }),
        db.transaction(async (tx) => {
          const cidr = await allocateBridgeSubnet(tx, {
            pool: "10.20.0.0/14",
          });
          await tx.execute(sql`
            INSERT INTO orgs (slug, name, owner_user_id, bridge_subnet)
            VALUES ('b', 'b', ${u2.id}::uuid, ${cidr}::cidr)
          `);
          return cidr;
        }),
      ]);
      assert.notEqual(cidrA, cidrB);
      // Pool is 10.20.0.0/14 → second octet must be 20–23, suffix .0/24.
      const inPool = /^10\.(20|21|22|23)\.\d+\.0\/24$/;
      assert.match(cidrA, inPool);
      assert.match(cidrB, inPool);
    });
  },
);
