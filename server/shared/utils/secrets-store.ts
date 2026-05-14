/**
 * Per-project encrypted secrets store.
 *
 * Secrets are AES-256-GCM encrypted and stored in
 * <dataDir>/.specifyr/<slug>/secrets.json. The master key is read from
 * SPECIFYR_SECRET_KEY (64-char hex = 32 bytes). If unset, a random key is
 * auto-generated and persisted in <dataDir>/master.key on first use.
 *
 * Threat model: secrets must not appear in git, specs, or AI chat.
 * This does NOT protect against access to the host filesystem.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dataDir, projectArtifactsDir } from "./data-dirs";

const writeQueues = new Map<string, Promise<void>>();

function queueKey(orgId: string, slug: string): string {
  return `${orgId}/${slug}`;
}

function enqueueWrite(orgId: string, slug: string, op: () => Promise<void>): Promise<void> {
  const k = queueKey(orgId, slug);
  const prev = writeQueues.get(k) ?? Promise.resolve();
  const next = prev.then(op, op);
  writeQueues.set(k, next.finally(() => {
    if (writeQueues.get(k) === next) writeQueues.delete(k);
  }));
  return next;
}

type EncryptedEntry = { iv: string; tag: string; data: string };
type SecretsFile = Record<string, EncryptedEntry>;

function secretsFilePath(orgId: string, slug: string): string {
  return path.join(projectArtifactsDir(orgId, slug), "secrets.json");
}

async function masterKey(): Promise<Buffer> {
  if (process.env.SPECIFYR_SECRET_KEY) {
    const key = Buffer.from(process.env.SPECIFYR_SECRET_KEY, "hex");
    if (key.length !== 32) throw new Error("SPECIFYR_SECRET_KEY must be 64 hex chars (32 bytes)");
    return key;
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

async function readFile(orgId: string, slug: string): Promise<SecretsFile> {
  try {
    return JSON.parse(await fs.readFile(secretsFilePath(orgId, slug), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function writeFile(orgId: string, slug: string, data: SecretsFile): Promise<void> {
  const p = secretsFilePath(orgId, slug);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2), { mode: 0o600 });
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

export async function listSecretKeys(orgId: string, slug: string): Promise<string[]> {
  return Object.keys(await readFile(orgId, slug));
}

export function setSecret(orgId: string, slug: string, key: string, value: string): Promise<void> {
  return enqueueWrite(orgId, slug, async () => {
    const [file, mkey] = await Promise.all([readFile(orgId, slug), masterKey()]);
    file[key] = encrypt(value, mkey);
    await writeFile(orgId, slug, file);
  });
}

export function deleteSecret(orgId: string, slug: string, key: string): Promise<boolean> {
  let existed = false;
  return enqueueWrite(orgId, slug, async () => {
    const file = await readFile(orgId, slug);
    if (!(key in file)) return;
    existed = true;
    delete file[key];
    await writeFile(orgId, slug, file);
  }).then(() => existed);
}

export async function getProjectSecrets(orgId: string, slug: string): Promise<Record<string, string>> {
  const [file, mkey] = await Promise.all([readFile(orgId, slug), masterKey()]);
  const result: Record<string, string> = {};
  for (const [k, entry] of Object.entries(file)) {
    result[k] = decrypt(entry, mkey);
  }
  return result;
}
