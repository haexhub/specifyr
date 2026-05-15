/**
 * Encrypted secrets store, two scopes:
 *   - org-level:     <dataDir>/.specifyr/<orgId>/secrets.json
 *   - project-level: <dataDir>/.specifyr/<orgId>/<projSlug>/secrets.json
 *
 * Project secrets override org secrets on key collision at injection time.
 *
 * Secrets are AES-256-GCM encrypted. The master key is read from
 * SPECIFYR_SECRET_KEY (64-char hex = 32 bytes). If unset, a random key is
 * auto-generated and persisted in <dataDir>/master.key on first use.
 *
 * Threat model: secrets must not appear in git, specs, or AI chat.
 * This does NOT protect against access to the host filesystem.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dataDir, orgArtifactsDir, projectArtifactsDir } from "./data-dirs";

/**
 * Reserved secret keys are managed by dedicated endpoints, not by the
 * generic `POST /api/projects/:slug/secrets` route — exposing them
 * would let a malformed client overwrite the git PAT or other
 * structured credentials.
 */
export const GIT_REMOTE_TOKEN_KEY = "__git_remote_token";

const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite(queueKey: string, op: () => Promise<void>): Promise<void> {
  const prev = writeQueues.get(queueKey) ?? Promise.resolve();
  const next = prev.then(op, op);
  writeQueues.set(queueKey, next.finally(() => {
    if (writeQueues.get(queueKey) === next) writeQueues.delete(queueKey);
  }));
  return next;
}

type EncryptedEntry = { iv: string; tag: string; data: string };
type SecretsFile = Record<string, EncryptedEntry>;

function projectSecretsFilePath(orgId: string, slug: string): string {
  return path.join(projectArtifactsDir(orgId, slug), "secrets.json");
}

function orgSecretsFilePath(orgId: string): string {
  return path.join(orgArtifactsDir(orgId), "secrets.json");
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

async function readSecretsFile(filePath: string): Promise<SecretsFile> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function writeSecretsFile(filePath: string, data: SecretsFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
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
  return Object.keys(await readSecretsFile(projectSecretsFilePath(orgId, slug)));
}

export function setSecret(orgId: string, slug: string, key: string, value: string): Promise<void> {
  const filePath = projectSecretsFilePath(orgId, slug);
  return enqueueWrite(filePath, async () => {
    const [file, mkey] = await Promise.all([readSecretsFile(filePath), masterKey()]);
    file[key] = encrypt(value, mkey);
    await writeSecretsFile(filePath, file);
  });
}

export function deleteSecret(orgId: string, slug: string, key: string): Promise<boolean> {
  let existed = false;
  const filePath = projectSecretsFilePath(orgId, slug);
  return enqueueWrite(filePath, async () => {
    const file = await readSecretsFile(filePath);
    if (!(key in file)) return;
    existed = true;
    delete file[key];
    await writeSecretsFile(filePath, file);
  }).then(() => existed);
}

export async function getProjectSecrets(orgId: string, slug: string): Promise<Record<string, string>> {
  const [file, mkey] = await Promise.all([
    readSecretsFile(projectSecretsFilePath(orgId, slug)),
    masterKey(),
  ]);
  const result: Record<string, string> = {};
  for (const [k, entry] of Object.entries(file)) {
    result[k] = decrypt(entry, mkey);
  }
  return result;
}

// Org-level secrets — shared across every project in the org. Project
// secrets with the same key override org secrets at injection time.

export async function listOrgSecretKeys(orgId: string): Promise<string[]> {
  return Object.keys(await readSecretsFile(orgSecretsFilePath(orgId)));
}

export function setOrgSecret(orgId: string, key: string, value: string): Promise<void> {
  const filePath = orgSecretsFilePath(orgId);
  return enqueueWrite(filePath, async () => {
    const [file, mkey] = await Promise.all([readSecretsFile(filePath), masterKey()]);
    file[key] = encrypt(value, mkey);
    await writeSecretsFile(filePath, file);
  });
}

export function deleteOrgSecret(orgId: string, key: string): Promise<boolean> {
  let existed = false;
  const filePath = orgSecretsFilePath(orgId);
  return enqueueWrite(filePath, async () => {
    const file = await readSecretsFile(filePath);
    if (!(key in file)) return;
    existed = true;
    delete file[key];
    await writeSecretsFile(filePath, file);
  }).then(() => existed);
}

export async function getOrgSecrets(orgId: string): Promise<Record<string, string>> {
  const [file, mkey] = await Promise.all([
    readSecretsFile(orgSecretsFilePath(orgId)),
    masterKey(),
  ]);
  const result: Record<string, string> = {};
  for (const [k, entry] of Object.entries(file)) {
    result[k] = decrypt(entry, mkey);
  }
  return result;
}
