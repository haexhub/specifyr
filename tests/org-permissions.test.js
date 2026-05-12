/**
 * Permission-store integration tests. Skip when DATABASE_URL is unset.
 *
 * Asserts:
 *   - admin gets every permission via short-circuit
 *   - non-member never gets a permission
 *   - explicit grant works for non-admin members
 *   - revoke is idempotent
 *   - granting to a non-member throws
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const skipReason = !process.env.DATABASE_URL
  ? "DATABASE_URL not set — skipping integration test"
  : false;

async function setup() {
  process.env.SPECIFYR_SECRET_KEY ||= crypto.randomBytes(32).toString("hex");
  const { cleanDb } = await import("./helpers/db.ts");
  await cleanDb();
  const { getDb } = await import("../server/shared/database/client.ts");
  const db = getDb();
  if (!db) throw new Error("DB unavailable");
  const { users, orgs, orgMemberships } = await import("../server/shared/database/schema.ts");

  const tag = Math.random().toString(36).slice(2, 8);
  const [admin] = await db.insert(users).values({ email: `admin-${tag}@local` }).returning();
  const [member] = await db.insert(users).values({ email: `member-${tag}@local` }).returning();
  const [stranger] = await db.insert(users).values({ email: `stranger-${tag}@local` }).returning();
  const [org] = await db
    .insert(orgs)
    .values({ slug: `t-${tag}`, name: `Test ${tag}`, ownerUserId: admin.id, createdBy: admin.id })
    .returning();
  await db.insert(orgMemberships).values([
    { orgId: org.id, userId: admin.id, role: "admin" },
    { orgId: org.id, userId: member.id, role: "member" },
  ]);
  return { db, admin, member, stranger, org };
}

test("hasPermission: admin short-circuits to true", { skip: skipReason }, async () => {
  const { admin, org } = await setup();
  const { hasPermission } = await import("../server/shared/utils/org-permissions-store.ts");
  assert.equal(await hasPermission(org.id, admin.id, "manage_extensions"), true);
});

test("hasPermission: non-member is always false", { skip: skipReason }, async () => {
  const { stranger, org } = await setup();
  const { hasPermission } = await import("../server/shared/utils/org-permissions-store.ts");
  assert.equal(await hasPermission(org.id, stranger.id, "manage_extensions"), false);
});

test("hasPermission: member without grant is false", { skip: skipReason }, async () => {
  const { member, org } = await setup();
  const { hasPermission } = await import("../server/shared/utils/org-permissions-store.ts");
  assert.equal(await hasPermission(org.id, member.id, "manage_extensions"), false);
});

test("grantPermission + hasPermission: member with grant is true", { skip: skipReason }, async () => {
  const { admin, member, org } = await setup();
  const { grantPermission, hasPermission } = await import(
    "../server/shared/utils/org-permissions-store.ts"
  );
  await grantPermission({
    orgId: org.id,
    userId: member.id,
    permission: "manage_extensions",
    grantedBy: admin.id,
  });
  assert.equal(await hasPermission(org.id, member.id, "manage_extensions"), true);
});

test("grantPermission: idempotent re-grant", { skip: skipReason }, async () => {
  const { admin, member, org } = await setup();
  const { grantPermission, listPermissions } = await import(
    "../server/shared/utils/org-permissions-store.ts"
  );
  await grantPermission({
    orgId: org.id,
    userId: member.id,
    permission: "manage_extensions",
    grantedBy: admin.id,
  });
  await grantPermission({
    orgId: org.id,
    userId: member.id,
    permission: "manage_extensions",
    grantedBy: admin.id,
  });
  const list = await listPermissions(org.id);
  assert.equal(list.length, 1);
});

test("grantPermission: non-member throws", { skip: skipReason }, async () => {
  const { admin, stranger, org } = await setup();
  const { grantPermission } = await import("../server/shared/utils/org-permissions-store.ts");
  await assert.rejects(
    () =>
      grantPermission({
        orgId: org.id,
        userId: stranger.id,
        permission: "manage_extensions",
        grantedBy: admin.id,
      }),
    /not a member/,
  );
});

test("revokePermission: removes the grant", { skip: skipReason }, async () => {
  const { admin, member, org } = await setup();
  const { grantPermission, revokePermission, hasPermission } = await import(
    "../server/shared/utils/org-permissions-store.ts"
  );
  await grantPermission({
    orgId: org.id,
    userId: member.id,
    permission: "manage_extensions",
    grantedBy: admin.id,
  });
  await revokePermission(org.id, member.id, "manage_extensions");
  assert.equal(await hasPermission(org.id, member.id, "manage_extensions"), false);
});

test("revokePermission: idempotent on missing grant", { skip: skipReason }, async () => {
  const { member, org } = await setup();
  const { revokePermission } = await import("../server/shared/utils/org-permissions-store.ts");
  await revokePermission(org.id, member.id, "manage_extensions");
  await revokePermission(org.id, member.id, "manage_extensions");
});
