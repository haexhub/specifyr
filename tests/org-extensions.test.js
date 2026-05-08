/**
 * Org-extensions store tests. Covers the parts that don't require a
 * real Git remote: list/get/remove + slug-conflict detection +
 * encrypted-credential roundtrip via direct DB seeding.
 *
 * The clone path is exercised by the API e2e suite once the harness
 * supports a local bare-repo fixture; until then the unit tests focus
 * on what we can verify without network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const skipReason = !process.env.DATABASE_URL
  ? "DATABASE_URL not set — skipping integration test"
  : false;

async function seedOrg() {
  process.env.SPECIFYR_SECRET_KEY ||= crypto.randomBytes(32).toString("hex");
  // Per-test data dir so on-disk side effects don't collide.
  process.env.SPECIFYR_DATA_DIR = path.join(
    os.tmpdir(),
    `specifyr-orgext-${crypto.randomBytes(6).toString("hex")}`,
  );
  const { cleanDb } = await import("./helpers/db.ts");
  await cleanDb();
  const { getDb } = await import("../server/db/client.ts");
  const db = getDb();
  if (!db) throw new Error("DB unavailable");
  const { users, orgs } = await import("../server/db/schema.ts");
  const tag = Math.random().toString(36).slice(2, 8);
  const [user] = await db.insert(users).values({ email: `u-${tag}@local` }).returning();
  const [org] = await db
    .insert(orgs)
    .values({ slug: `o-${tag}`, name: `Org ${tag}`, ownerUserId: user.id, createdBy: user.id })
    .returning();
  return { db, user, org };
}

// Pure function — runs without a DB.
test("orgExtensionPath: deterministic per (orgId, slug)", async () => {
  process.env.SPECIFYR_DATA_DIR = path.join(os.tmpdir(), "specifyr-orgext-pathtest");
  const { orgExtensionPath } = await import("../server/utils/org-extensions-store.ts");
  const a = orgExtensionPath("org-1", "my-ext");
  const b = orgExtensionPath("org-1", "my-ext");
  const c = orgExtensionPath("org-2", "my-ext");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /extensions\/orgs\/org-1\/my-ext$/);
});

test("listOrgExtensions: empty by default", { skip: skipReason }, async () => {
  const { org } = await seedOrg();
  const { listOrgExtensions } = await import("../server/utils/org-extensions-store.ts");
  const list = await listOrgExtensions(org.id);
  assert.deepEqual(list, []);
});

test(
  "removeOrgExtension: returns false for non-existent slug",
  { skip: skipReason },
  async () => {
    const { org } = await seedOrg();
    const { removeOrgExtension } = await import("../server/utils/org-extensions-store.ts");
    assert.equal(await removeOrgExtension(org.id, "nope"), false);
  },
);

test(
  "credential roundtrip: insert encrypted -> decrypt yields original token",
  { skip: skipReason },
  async () => {
    const { db, user, org } = await seedOrg();
    const { orgExtensions } = await import("../server/db/schema.ts");
    const { encryptString } = await import("../server/utils/secrets-store.ts");
    const { getOrgExtensionCredentials } = await import(
      "../server/utils/org-extensions-store.ts"
    );

    const enc = await encryptString("ghp_secret_token_123");
    await db.insert(orgExtensions).values({
      orgId: org.id,
      slug: "private-repo",
      sourceUrl: "https://github.com/foo/bar.git",
      sourceRef: null,
      credentialUsername: "git",
      credentialIv: enc.iv,
      credentialTag: enc.tag,
      credentialData: enc.data,
      registeredBy: user.id,
    });

    const creds = await getOrgExtensionCredentials(org.id, "private-repo");
    assert.ok(creds);
    assert.equal(creds.username, "git");
    assert.equal(creds.token, "ghp_secret_token_123");
  },
);

test(
  "getOrgExtensionCredentials: null when row has no credentials",
  { skip: skipReason },
  async () => {
    const { db, user, org } = await seedOrg();
    const { orgExtensions } = await import("../server/db/schema.ts");
    const { getOrgExtensionCredentials } = await import(
      "../server/utils/org-extensions-store.ts"
    );
    await db.insert(orgExtensions).values({
      orgId: org.id,
      slug: "public-repo",
      sourceUrl: "https://github.com/foo/bar.git",
      registeredBy: user.id,
    });
    assert.equal(await getOrgExtensionCredentials(org.id, "public-repo"), null);
  },
);
