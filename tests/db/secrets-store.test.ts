/**
 * secrets-store covers two things: a pure encryption pair
 * (encryptString/decryptString, used by llm-credentials-store) and a
 * per-org Postgres-backed store (setSecret/getProjectSecrets,
 * setOrgSecret/getOrgSecrets) used by the runner.
 *
 * Tests:
 *   - encrypt → decrypt roundtrip with stable plaintext
 *   - tampered ciphertext is rejected (auth tag check)
 *   - SPECIFYR_SECRET_KEY length is validated
 *   - DB store roundtrip in a per-test isolated org_schema
 *   - deleteSecret is idempotent
 *   - org + project precedence at the call sites
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { skipIfNoDb, withDb } from "../helpers/db.ts";
import { createOrgSchema } from "../../server/shared/utils/per-org-schema.ts";

test("encryptString/decryptString roundtrip preserves plaintext", async () => {
  const { encryptString, decryptString } = await import(
    "../../server/shared/utils/secrets-store.ts"
  );
  const plaintext = "sk-ant-very-secret-key-1234567890";
  const enc = await encryptString(plaintext);
  assert.notEqual(enc.data, plaintext, "ciphertext must differ from plaintext");
  assert.match(enc.iv, /^[0-9a-f]+$/);
  assert.match(enc.tag, /^[0-9a-f]+$/);
  assert.equal(await decryptString(enc), plaintext);
});

test("encryptString produces a fresh IV each call", async () => {
  const { encryptString } = await import(
    "../../server/shared/utils/secrets-store.ts"
  );
  const a = await encryptString("same input");
  const b = await encryptString("same input");
  assert.notEqual(a.iv, b.iv, "IV reuse breaks GCM security");
  assert.notEqual(a.data, b.data);
});

test("decryptString rejects a tampered ciphertext", async () => {
  const { encryptString, decryptString } = await import(
    "../../server/shared/utils/secrets-store.ts"
  );
  const enc = await encryptString("plaintext");
  const tampered = {
    ...enc,
    data: (enc.data[0] === "a" ? "b" : "a") + enc.data.slice(1),
  };
  await assert.rejects(decryptString(tampered));
});

test("masterKey rejects a malformed SPECIFYR_SECRET_KEY", async () => {
  const previous = process.env.SPECIFYR_SECRET_KEY;
  process.env.SPECIFYR_SECRET_KEY = "tooshort";
  try {
    const { encryptString } = await import(
      "../../server/shared/utils/secrets-store.ts"
    );
    await assert.rejects(encryptString("x"), /64 hex chars/);
  } finally {
    process.env.SPECIFYR_SECRET_KEY = previous;
  }
});

test(
  "setSecret / getProjectSecrets / deleteSecret roundtrip",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const orgId = crypto.randomUUID();
      await db.transaction((tx) => createOrgSchema(tx, orgId));

      const { setSecret, getProjectSecrets, deleteSecret, listSecretKeys } =
        await import("../../server/shared/utils/secrets-store.ts");
      const slug = "test-project-roundtrip";
      await setSecret(orgId, slug, "FOO", "bar");
      await setSecret(orgId, slug, "BAZ", "qux");
      assert.deepEqual(
        (await listSecretKeys(orgId, slug)).sort(),
        ["BAZ", "FOO"],
      );
      assert.deepEqual(await getProjectSecrets(orgId, slug), {
        FOO: "bar",
        BAZ: "qux",
      });

      assert.equal(await deleteSecret(orgId, slug, "FOO"), true);
      assert.equal(
        await deleteSecret(orgId, slug, "FOO"),
        false,
        "second delete is idempotent",
      );
      assert.deepEqual(await getProjectSecrets(orgId, slug), { BAZ: "qux" });
    });
  },
);

test(
  "getProjectSecrets returns {} for an unknown slug",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const orgId = crypto.randomUUID();
      await db.transaction((tx) => createOrgSchema(tx, orgId));
      const { getProjectSecrets } = await import(
        "../../server/shared/utils/secrets-store.ts"
      );
      assert.deepEqual(await getProjectSecrets(orgId, "never-seen-before"), {});
    });
  },
);

test(
  "setSecret/getSecret roundtrip for git remote token",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const orgId = crypto.randomUUID();
      await db.transaction((tx) => createOrgSchema(tx, orgId));

      const mod = await import("../../server/shared/utils/secrets-store.ts");
      const key = mod.GIT_REMOTE_TOKEN_KEY;
      assert.match(key, /^__/, "reserved keys are prefixed with __");
      await mod.setSecret(orgId, "git-token-test", key, "ghp_testtoken123");
      const secrets = await mod.getProjectSecrets(orgId, "git-token-test");
      assert.equal(secrets[key], "ghp_testtoken123");
    });
  },
);

test(
  "org and project secrets share encryption format but live in separate tables",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const orgId = crypto.randomUUID();
      await db.transaction((tx) => createOrgSchema(tx, orgId));

      const mod = await import("../../server/shared/utils/secrets-store.ts");
      await mod.setOrgSecret(orgId, "SHARED", "org-value");
      await mod.setSecret(orgId, "proj-a", "SHARED", "project-value");

      assert.deepEqual(await mod.getOrgSecrets(orgId), { SHARED: "org-value" });
      assert.deepEqual(await mod.getProjectSecrets(orgId, "proj-a"), {
        SHARED: "project-value",
      });
      assert.deepEqual(await mod.getProjectSecrets(orgId, "proj-b"), {});
    });
  },
);

test(
  "deleteAllProjectSecrets removes every row for a slug",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const orgId = crypto.randomUUID();
      await db.transaction((tx) => createOrgSchema(tx, orgId));

      const mod = await import("../../server/shared/utils/secrets-store.ts");
      await mod.setSecret(orgId, "doomed", "A", "1");
      await mod.setSecret(orgId, "doomed", "B", "2");
      await mod.setSecret(orgId, "kept", "C", "3");

      await mod.deleteAllProjectSecrets(orgId, "doomed");
      assert.deepEqual(await mod.getProjectSecrets(orgId, "doomed"), {});
      assert.deepEqual(await mod.getProjectSecrets(orgId, "kept"), { C: "3" });
    });
  },
);
