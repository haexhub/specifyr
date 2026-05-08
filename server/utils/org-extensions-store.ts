import path from "node:path";
import fs from "node:fs/promises";
import { and, count, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  orgExtensions,
  type OrgExtension,
} from "../db/schema";
import { dataDir } from "./data-dirs";
import { encryptString, decryptString } from "./secrets-store";
import { gitClone } from "./git-clone";
import { readLocalManifest } from "./local-extension";

/** Hard upper bound to keep a single org from filling the disk via repeated adds. */
const MAX_EXTENSIONS_PER_ORG = 100;

/**
 * Absolute on-disk path where an org's extensions live. Reconstructable
 * from `(orgId, slug)` so the DB row doesn't need to store it.
 *
 *   <dataDir>/extensions/orgs/<orgId>/<slug>/
 */
export function orgExtensionPath(orgId: string, slug: string): string {
  return path.join(dataDir(), "extensions", "orgs", orgId, slug);
}

export interface OrgExtensionListEntry {
  id: string;
  slug: string;
  sourceUrl: string;
  sourceRef: string | null;
  hasCredentials: boolean;
  registeredBy: string | null;
  registeredAt: Date;
  updatedAt: Date;
  path: string;
}

function toListEntry(row: OrgExtension): OrgExtensionListEntry {
  return {
    id: row.id,
    slug: row.slug,
    sourceUrl: row.sourceUrl,
    sourceRef: row.sourceRef,
    hasCredentials: !!row.credentialIv,
    registeredBy: row.registeredBy,
    registeredAt: row.registeredAt,
    updatedAt: row.updatedAt,
    path: orgExtensionPath(row.orgId, row.slug),
  };
}

export async function listOrgExtensions(
  orgId: string,
): Promise<OrgExtensionListEntry[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(orgExtensions)
    .where(eq(orgExtensions.orgId, orgId));
  return rows.map(toListEntry);
}

export async function getOrgExtensionBySlug(
  orgId: string,
  slug: string,
): Promise<OrgExtensionListEntry | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(orgExtensions)
    .where(and(eq(orgExtensions.orgId, orgId), eq(orgExtensions.slug, slug)))
    .limit(1);
  return row ? toListEntry(row) : null;
}

export interface AddOrgExtensionInput {
  orgId: string;
  sourceUrl: string;
  sourceRef?: string | null;
  credentials?: { username: string; token: string } | null;
  registeredBy: string;
}

export interface AddOrgExtensionResult {
  ok: true;
  extension: OrgExtensionListEntry;
}

export interface AddOrgExtensionError {
  ok: false;
  reason:
    | "quota_exceeded"
    | "clone_failed"
    | "manifest_invalid"
    | "slug_conflict"
    | "url_invalid";
  message: string;
}

/**
 * Adds an org extension end-to-end:
 *   1. quota check
 *   2. clone into a fresh temp dir within the org's sandbox
 *   3. parse extension.yml, slug derives from extension.id
 *   4. atomic rename to the final slug-named dir; rejects on conflict
 *   5. persist DB row with optionally-encrypted credentials
 *
 * On any failure between (2) and (5), the partial clone is removed.
 */
export async function addOrgExtension(
  input: AddOrgExtensionInput,
): Promise<AddOrgExtensionResult | AddOrgExtensionError> {
  const db = getDb();
  if (!db) throw new Error("DB not configured");

  // Quota guard.
  const [quota] = await db
    .select({ n: count() })
    .from(orgExtensions)
    .where(eq(orgExtensions.orgId, input.orgId));
  if (Number(quota?.n ?? 0) >= MAX_EXTENSIONS_PER_ORG) {
    return {
      ok: false,
      reason: "quota_exceeded",
      message: `org has reached the limit of ${MAX_EXTENSIONS_PER_ORG} extensions`,
    };
  }

  // Clone to a temp dir; we don't know the slug until we've read
  // extension.yml, and we don't want a partial dir at the final path.
  const orgRoot = path.join(dataDir(), "extensions", "orgs", input.orgId);
  await fs.mkdir(orgRoot, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(orgRoot, ".tmp-clone-"));
  // mkdtemp creates the dir; gitClone needs it to NOT exist, so use a child path.
  const cloneDir = path.join(tempDir, "ext");

  const clone = await gitClone({
    url: input.sourceUrl,
    ref: input.sourceRef ?? null,
    credentials: input.credentials ?? null,
    destination: cloneDir,
  }).catch((err: Error) => ({ ok: false as const, stderr: err.message }));
  if (!clone.ok) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    const reason: AddOrgExtensionError["reason"] =
      /only https/.test(clone.stderr) || /URL host/.test(clone.stderr) || /invalid URL/.test(clone.stderr)
        ? "url_invalid"
        : "clone_failed";
    return { ok: false, reason, message: clone.stderr.trim() || "git clone failed" };
  }

  let manifest;
  try {
    manifest = await readLocalManifest(cloneDir);
  } catch (err) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return {
      ok: false,
      reason: "manifest_invalid",
      message: (err as Error).message,
    };
  }

  const slug = manifest.slug;
  const finalDir = orgExtensionPath(input.orgId, slug);

  // Reject overlap with an existing slug for this org. Done before
  // rename so we can keep the ENOENT-only semantics of fs.rename.
  const [existing] = await db
    .select()
    .from(orgExtensions)
    .where(and(eq(orgExtensions.orgId, input.orgId), eq(orgExtensions.slug, slug)))
    .limit(1);
  if (existing) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return {
      ok: false,
      reason: "slug_conflict",
      message: `slug '${slug}' is already registered for this org`,
    };
  }

  // Final rename and stale-dir cleanup.
  await fs.rm(finalDir, { recursive: true, force: true }).catch(() => {});
  await fs.rename(cloneDir, finalDir);
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

  let credentialFields: Partial<OrgExtension> = {};
  if (input.credentials) {
    if (!input.credentials.username || !input.credentials.token) {
      return {
        ok: false,
        reason: "url_invalid",
        message: "credentials.username and credentials.token are both required",
      };
    }
    const enc = await encryptString(input.credentials.token);
    credentialFields = {
      credentialUsername: input.credentials.username,
      credentialIv: enc.iv,
      credentialTag: enc.tag,
      credentialData: enc.data,
    };
  }

  const [row] = await db
    .insert(orgExtensions)
    .values({
      orgId: input.orgId,
      slug,
      sourceUrl: input.sourceUrl,
      sourceRef: input.sourceRef ?? null,
      registeredBy: input.registeredBy,
      ...credentialFields,
    })
    .returning();
  if (!row) {
    await fs.rm(finalDir, { recursive: true, force: true }).catch(() => {});
    throw new Error("org_extensions insert returned no row");
  }
  return { ok: true, extension: toListEntry(row) };
}

/**
 * Removes the DB row and the on-disk clone. Returns false if the row
 * didn't exist (caller can map to 404).
 */
export async function removeOrgExtension(
  orgId: string,
  slug: string,
): Promise<boolean> {
  const db = getDb();
  if (!db) throw new Error("DB not configured");

  const deleted = await db
    .delete(orgExtensions)
    .where(and(eq(orgExtensions.orgId, orgId), eq(orgExtensions.slug, slug)))
    .returning();
  if (deleted.length === 0) return false;
  await fs
    .rm(orgExtensionPath(orgId, slug), { recursive: true, force: true })
    .catch(() => {});
  return true;
}

/**
 * Reads the stored token back. Used by the (future) refresh endpoint
 * and tests. Throws on a row that's missing the encrypted fields
 * because that means the row was tampered with manually.
 */
export async function getOrgExtensionCredentials(
  orgId: string,
  slug: string,
): Promise<{ username: string; token: string } | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(orgExtensions)
    .where(and(eq(orgExtensions.orgId, orgId), eq(orgExtensions.slug, slug)))
    .limit(1);
  if (!row) return null;
  if (!row.credentialIv) return null;
  if (!row.credentialUsername || !row.credentialTag || !row.credentialData) {
    throw new Error(`org_extensions row '${slug}' has partial credentials`);
  }
  const token = await decryptString({
    iv: row.credentialIv,
    tag: row.credentialTag,
    data: row.credentialData,
  });
  return { username: row.credentialUsername, token };
}
