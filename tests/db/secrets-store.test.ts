/**
 * secrets-store covers two things: a pure encryption pair
 * (encryptString/decryptString, used by llm-credentials-store) and a
 * project-scoped file store (setSecret/getProjectSecrets, used by the
 * runner). Tests:
 *   - encrypt → decrypt roundtrip with stable plaintext
 *   - tampered ciphertext is rejected (auth tag check)
 *   - SPECIFYR_SECRET_KEY length is validated
 *   - file store roundtrip in an isolated SPECIFYR_DATA_DIR
 *   - deleteSecret is idempotent
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let tmpDataDir: string;
let originalDataDir: string | undefined;
let originalSecretKey: string | undefined;

before(async () => {
  tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "specifyr-secrets-"));
  originalDataDir = process.env.SPECIFYR_DATA_DIR;
  originalSecretKey = process.env.SPECIFYR_SECRET_KEY;
  process.env.SPECIFYR_DATA_DIR = tmpDataDir;
  process.env.SPECIFYR_SECRET_KEY = crypto.randomBytes(32).toString("hex");
});

after(async () => {
  if (originalDataDir === undefined) delete process.env.SPECIFYR_DATA_DIR;
  else process.env.SPECIFYR_DATA_DIR = originalDataDir;
  if (originalSecretKey === undefined) delete process.env.SPECIFYR_SECRET_KEY;
  else process.env.SPECIFYR_SECRET_KEY = originalSecretKey;
  await fs.rm(tmpDataDir, { recursive: true, force: true });
});

test("encryptString/decryptString roundtrip preserves plaintext", async () => {
  const { encryptString, decryptString } = await import(
    "../../server/utils/secrets-store.ts"
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
    "../../server/utils/secrets-store.ts"
  );
  const a = await encryptString("same input");
  const b = await encryptString("same input");
  assert.notEqual(a.iv, b.iv, "IV reuse breaks GCM security");
  assert.notEqual(a.data, b.data);
});

test("decryptString rejects a tampered ciphertext", async () => {
  const { encryptString, decryptString } = await import(
    "../../server/utils/secrets-store.ts"
  );
  const enc = await encryptString("plaintext");
  // Flip a byte in the data — auth tag check must fail.
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
    // Re-import to re-read the env (the module reads on each call so
    // this works without esm cache busting, but be explicit).
    const { encryptString } = await import(
      "../../server/utils/secrets-store.ts"
    );
    await assert.rejects(encryptString("x"), /64 hex chars/);
  } finally {
    process.env.SPECIFYR_SECRET_KEY = previous;
  }
});

test("setSecret / getProjectSecrets / deleteSecret roundtrip", async () => {
  const { setSecret, getProjectSecrets, deleteSecret, listSecretKeys } =
    await import("../../server/utils/secrets-store.ts");
  const slug = "test-project-roundtrip";
  await setSecret(slug, "FOO", "bar");
  await setSecret(slug, "BAZ", "qux");
  assert.deepEqual(
    (await listSecretKeys(slug)).sort(),
    ["BAZ", "FOO"],
  );
  assert.deepEqual(await getProjectSecrets(slug), { FOO: "bar", BAZ: "qux" });

  assert.equal(await deleteSecret(slug, "FOO"), true);
  assert.equal(await deleteSecret(slug, "FOO"), false, "second delete is idempotent");
  assert.deepEqual(await getProjectSecrets(slug), { BAZ: "qux" });
});

test("getProjectSecrets returns {} for an unknown slug", async () => {
  const { getProjectSecrets } = await import(
    "../../server/utils/secrets-store.ts"
  );
  assert.deepEqual(await getProjectSecrets("never-seen-before"), {});
});
