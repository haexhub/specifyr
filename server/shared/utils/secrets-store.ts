/**
 * Encrypted secrets store, two scopes:
 *   - org-level:     <org_schema>.org_secrets
 *   - project-level: <org_schema>.project_secrets (keyed by project slug)
 *
 * Project secrets override org secrets on key collision at injection time.
 *
 * Secrets are AES-256-GCM encrypted. The master key is read from
 * SPECIFYR_SECRET_KEY (64-char hex = 32 bytes). If unset, a random key is
 * auto-generated and persisted in <dataDir>/master.key on first use.
 *
 * Threat model: secrets must not appear in git, specs, or AI chat.
 * Postgres + per-org schemas provide tenant isolation at the DB layer;
 * with multi-instance deploys a shared filesystem is no longer required.
 *
 * Phase 3 (vault daemon, planned): per-org DEK from the per-org master_keys
 * table replaces the global master key. The (iv, tag, ciphertext) shape
 * stays the same so the table doesn't need to change — only the key
 * resolution layer above does.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { dataDir } from "./data-dirs";
import { getDb } from "../database/client";
import { orgSchemaName } from "./per-org-schema";

/**
 * Reserved secret keys are managed by dedicated endpoints, not by the
 * generic `POST /api/projects/:slug/secrets` route — exposing them
 * would let a malformed client overwrite the git PAT or other
 * structured credentials.
 */
export const GIT_REMOTE_TOKEN_KEY = "__git_remote_token";

type EncryptedEntry = { iv: string; tag: string; data: string };

async function masterKey(): Promise<Buffer> {
  if (process.env.SPECIFYR_SECRET_KEY) {
    const key = Buffer.from(process.env.SPECIFYR_SECRET_KEY, "hex");
    if (key.length !== 32) throw new Error("SPECIFYR_SECRET_KEY must be 64 hex chars (32 bytes)");
    return key;
  }
  // Shared DB ⇒ shared master key. A locally-generated per-instance
  // <dataDir>/master.key would silently make ciphertext written by one
  // instance unreadable from another and lock secrets to one node's
  // filesystem. Fail fast instead.
  if (process.env.DATABASE_URL) {
    throw new Error(
      "secrets-store: SPECIFYR_SECRET_KEY is required when DATABASE_URL is configured. " +
        "Generate with `openssl rand -hex 32` and set it in the environment.",
    );
  }
  const keyPath = path.join(dataDir(), "master.key");
  try {
    const hex = (await fs.readFile(keyPath, "utf8")).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error(`master.key is malformed — expected 64 hex chars, got ${hex.length}`);
    }
    return Buffer.from(hex, "hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const key = crypto.randomBytes(32);
    await fs.mkdir(path.dirname(keyPath), { recursive: true });
    await fs.writeFile(keyPath, key.toString("hex"), { mode: 0o600 });
    console.warn(`[secrets-store] Generated new master key at ${keyPath} — back this file up.`);
    return key;
  }
}

function encrypt(plaintext: string, key: Buffer): EncryptedEntry {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    data: data.toString("hex"),
  };
}

function decrypt(entry: EncryptedEntry, key: Buffer): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "hex"));
  decipher.setAuthTag(Buffer.from(entry.tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(entry.data, "hex")), decipher.final()]).toString("utf8");
}

function requireDb() {
  const db = getDb();
  if (!db) {
    throw new Error(
      "secrets-store: DATABASE_URL is not configured — Postgres is required to read/write secrets.",
    );
  }
  return db;
}

// Re-exports so other stores (llm-credentials, future ones) share the
// same master-key plumbing instead of each rolling its own.
export { masterKey };
export async function encryptString(plaintext: string): Promise<EncryptedEntry> {
  return encrypt(plaintext, await masterKey());
}
export async function decryptString(entry: EncryptedEntry): Promise<string> {
  return decrypt(entry, await masterKey());
}
export type { EncryptedEntry };

// ---------------------------------------------------------------------------
// Project-scoped secrets
// ---------------------------------------------------------------------------

export async function listSecretKeys(orgId: string, slug: string): Promise<string[]> {
  const db = requireDb();
  const schema = orgSchemaName(orgId);
  const rows = await db.execute<{ key: string }>(
    sql`SELECT key FROM ${sql.identifier(schema)}.project_secrets WHERE project_slug = ${slug} ORDER BY key`,
  );
  return rows.rows.map((r) => r.key);
}

export async function setSecret(
  orgId: string,
  slug: string,
  key: string,
  value: string,
): Promise<void> {
  const db = requireDb();
  const schema = orgSchemaName(orgId);
  const entry = encrypt(value, await masterKey());
  await db.execute(
    sql`
      INSERT INTO ${sql.identifier(schema)}.project_secrets
        (project_slug, key, iv, tag, encrypted_value, created_at, updated_at)
      VALUES (${slug}, ${key}, ${entry.iv}, ${entry.tag}, ${entry.data}, now(), now())
      ON CONFLICT (project_slug, key) DO UPDATE SET
        iv = EXCLUDED.iv,
        tag = EXCLUDED.tag,
        encrypted_value = EXCLUDED.encrypted_value,
        updated_at = now()
    `,
  );
}

export async function deleteSecret(
  orgId: string,
  slug: string,
  key: string,
): Promise<boolean> {
  const db = requireDb();
  const schema = orgSchemaName(orgId);
  const result = await db.execute(
    sql`DELETE FROM ${sql.identifier(schema)}.project_secrets
        WHERE project_slug = ${slug} AND key = ${key}`,
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getProjectSecrets(
  orgId: string,
  slug: string,
): Promise<Record<string, string>> {
  const db = requireDb();
  const schema = orgSchemaName(orgId);
  const mkey = await masterKey();
  const rows = await db.execute<{ key: string; iv: string; tag: string; encrypted_value: string }>(
    sql`SELECT key, iv, tag, encrypted_value
        FROM ${sql.identifier(schema)}.project_secrets
        WHERE project_slug = ${slug}`,
  );
  const result: Record<string, string> = {};
  for (const r of rows.rows) {
    result[r.key] = decrypt({ iv: r.iv, tag: r.tag, data: r.encrypted_value }, mkey);
  }
  return result;
}

/**
 * Removes every project_secrets row for a slug. Called from the
 * project-delete handler — the per-org schema has no cross-schema FK
 * to projects, so cleanup is the application's job.
 */
export async function deleteAllProjectSecrets(
  orgId: string,
  slug: string,
): Promise<void> {
  const db = requireDb();
  const schema = orgSchemaName(orgId);
  await db.execute(
    sql`DELETE FROM ${sql.identifier(schema)}.project_secrets WHERE project_slug = ${slug}`,
  );
}

// ---------------------------------------------------------------------------
// Org-scoped secrets
// ---------------------------------------------------------------------------

export async function listOrgSecretKeys(orgId: string): Promise<string[]> {
  const db = requireDb();
  const schema = orgSchemaName(orgId);
  const rows = await db.execute<{ key: string }>(
    sql`SELECT key FROM ${sql.identifier(schema)}.org_secrets ORDER BY key`,
  );
  return rows.rows.map((r) => r.key);
}

export async function setOrgSecret(
  orgId: string,
  key: string,
  value: string,
): Promise<void> {
  const db = requireDb();
  const schema = orgSchemaName(orgId);
  const entry = encrypt(value, await masterKey());
  await db.execute(
    sql`
      INSERT INTO ${sql.identifier(schema)}.org_secrets
        (key, iv, tag, encrypted_value, created_at, updated_at)
      VALUES (${key}, ${entry.iv}, ${entry.tag}, ${entry.data}, now(), now())
      ON CONFLICT (key) DO UPDATE SET
        iv = EXCLUDED.iv,
        tag = EXCLUDED.tag,
        encrypted_value = EXCLUDED.encrypted_value,
        updated_at = now()
    `,
  );
}

export async function deleteOrgSecret(orgId: string, key: string): Promise<boolean> {
  const db = requireDb();
  const schema = orgSchemaName(orgId);
  const result = await db.execute(
    sql`DELETE FROM ${sql.identifier(schema)}.org_secrets WHERE key = ${key}`,
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getOrgSecrets(orgId: string): Promise<Record<string, string>> {
  const db = requireDb();
  const schema = orgSchemaName(orgId);
  const mkey = await masterKey();
  const rows = await db.execute<{ key: string; iv: string; tag: string; encrypted_value: string }>(
    sql`SELECT key, iv, tag, encrypted_value FROM ${sql.identifier(schema)}.org_secrets`,
  );
  const result: Record<string, string> = {};
  for (const r of rows.rows) {
    result[r.key] = decrypt({ iv: r.iv, tag: r.tag, data: r.encrypted_value }, mkey);
  }
  return result;
}
