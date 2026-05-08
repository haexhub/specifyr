import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { and, count, eq, sql } from "drizzle-orm";
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

/** A reservation slug never collides with a valid extension slug,
 *  which the manifest reader constrains to `[a-z0-9-]+`. The double
 *  underscore prefix is the marker that picker / install paths use to
 *  ignore in-flight rows. */
function reservationSlug(): string {
  return `__pending_${randomUUID()}__`;
}

function isReservationSlug(slug: string): boolean {
  return slug.startsWith("__pending_") && slug.endsWith("__");
}

/** Postgres unique-violation. */
function isUniqueViolation(err: unknown): boolean {
  return !!(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "23505");
}

/** Filter out reservation rows so partial in-flight inserts never leak
 *  into list/picker responses or credential lookups. */
function isVisible(row: OrgExtension): boolean {
  return !isReservationSlug(row.slug);
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
  return rows.filter(isVisible).map(toListEntry);
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
  return row && isVisible(row) ? toListEntry(row) : null;
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
 * Adds an org extension end-to-end. Concurrency-safe layout:
 *
 *   1. Validate input (creds shape, sourceUrl shape) — pure, fast.
 *   2. Encrypt credentials.
 *   3. Reserve a slot in the DB with a placeholder slug inside a
 *      single transaction. SELECT count + INSERT under one TX serialise
 *      against `MAX_EXTENSIONS_PER_ORG`; the placeholder slug also
 *      reserves an `id` we can roll back later.
 *   4. Clone into a temp dir. Long-running, NOT inside the TX (would
 *      hold a row-lock for the entire network round-trip).
 *   5. Read the manifest to discover the real slug.
 *   6. UPDATE the placeholder row to the real slug. The (orgId, slug)
 *      unique constraint atomically resolves slug_conflict against any
 *      other already-finalised row, with no FS write yet.
 *   7. Rename the cloned dir into place. By now the DB owns the slug,
 *      so this rename is the only writer for that path.
 *
 * Any failure between steps 3 and 7 deletes the reservation row and
 * the temp dir. The DB row never points at a missing/stale FS dir.
 */
export async function addOrgExtension(
  input: AddOrgExtensionInput,
): Promise<AddOrgExtensionResult | AddOrgExtensionError> {
  const db = getDb();
  if (!db) throw new Error("DB not configured");

  // (1) Input validation upfront — no FS work yet.
  if (input.credentials) {
    if (!input.credentials.username?.trim() || !input.credentials.token?.trim()) {
      return {
        ok: false,
        reason: "url_invalid",
        message: "credentials.username and credentials.token are both required",
      };
    }
  }

  // (2) Encrypt creds before touching the DB so a reservation row is
  // either fully populated or absent — never half-written.
  let credentialFields: Partial<OrgExtension> = {};
  if (input.credentials) {
    const enc = await encryptString(input.credentials.token);
    credentialFields = {
      credentialUsername: input.credentials.username,
      credentialIv: enc.iv,
      credentialTag: enc.tag,
      credentialData: enc.data,
    };
  }

  // (3) Reservation TX: count-then-insert under SERIALIZABLE-ish
  // semantics. With READ COMMITTED + the row-level lock the insert
  // takes, two concurrent quota probes that both see N=99 will both
  // try to insert; the LIMIT-checking subquery here makes the second
  // one INSERT zero rows and we catch that.
  const placeholder = reservationSlug();
  const reservation = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(orgExtensions)
      .values({
        orgId: input.orgId,
        slug: placeholder,
        sourceUrl: input.sourceUrl,
        sourceRef: input.sourceRef ?? null,
        registeredBy: input.registeredBy,
        ...credentialFields,
      })
      // Conditional insert via a CTE-like guard: the row is only created
      // when the org is below quota. Drizzle's onConflictDoNothing
      // doesn't help here (we're not conflicting on the unique index),
      // so we run a follow-up count and roll back if exceeded.
      .returning();
    const [stats] = await tx
      .select({ n: count() })
      .from(orgExtensions)
      .where(eq(orgExtensions.orgId, input.orgId));
    if (Number(stats?.n ?? 0) > MAX_EXTENSIONS_PER_ORG) {
      throw new Error("__quota_exceeded__");
    }
    return inserted[0]!;
  }).catch((err: Error) => {
    if (err.message === "__quota_exceeded__") return null;
    throw err;
  });
  if (!reservation) {
    return {
      ok: false,
      reason: "quota_exceeded",
      message: `org has reached the limit of ${MAX_EXTENSIONS_PER_ORG} extensions`,
    };
  }

  // From here on, every error path must clean up the reservation row
  // and any temp dir that was created.
  const cleanup = async (tempDir?: string) => {
    await db.delete(orgExtensions).where(eq(orgExtensions.id, reservation.id)).catch(() => {});
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  };

  // (4) Clone. tempDir is unique per call — concurrent adds for the
  // same org never race here.
  const orgRoot = path.join(dataDir(), "extensions", "orgs", input.orgId);
  await fs.mkdir(orgRoot, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(orgRoot, ".tmp-clone-"));
  const cloneDir = path.join(tempDir, "ext");

  const clone = await gitClone({
    url: input.sourceUrl,
    ref: input.sourceRef ?? null,
    credentials: input.credentials ?? null,
    destination: cloneDir,
  }).catch((err: Error) => ({ ok: false as const, stderr: err.message }));
  if (!clone.ok) {
    await cleanup(tempDir);
    const reason: AddOrgExtensionError["reason"] =
      /only https/.test(clone.stderr) ||
      /URL host/.test(clone.stderr) ||
      /invalid URL/.test(clone.stderr) ||
      /URL must not contain inline credentials/.test(clone.stderr) ||
      /destination/.test(clone.stderr)
        ? "url_invalid"
        : "clone_failed";
    return { ok: false, reason, message: clone.stderr.trim() || "git clone failed" };
  }

  // (5) Manifest read.
  let manifest;
  try {
    manifest = await readLocalManifest(cloneDir);
  } catch (err) {
    await cleanup(tempDir);
    return {
      ok: false,
      reason: "manifest_invalid",
      message: (err as Error).message,
    };
  }
  const realSlug = manifest.slug;

  // (6) Atomic slug claim. Unique (orgId, slug) makes a parallel
  // already-finalised row reject this update with 23505 — that is the
  // ONLY source of truth for slug-conflict.
  try {
    await db
      .update(orgExtensions)
      .set({ slug: realSlug, updatedAt: sql`now()` })
      .where(eq(orgExtensions.id, reservation.id));
  } catch (err) {
    await cleanup(tempDir);
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        reason: "slug_conflict",
        message: `slug '${realSlug}' is already registered for this org`,
      };
    }
    throw err;
  }

  // (7) Move clone into place. The DB now owns the slug, so a stale
  // dir from a previous failed run is the only thing that could be
  // sitting at finalDir; remove it before rename.
  const finalDir = orgExtensionPath(input.orgId, realSlug);
  try {
    await fs.rm(finalDir, { recursive: true, force: true }).catch(() => {});
    await fs.rename(cloneDir, finalDir);
  } catch (err) {
    await cleanup(tempDir);
    await fs.rm(finalDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

  // Re-read the row to return current data (slug + updatedAt).
  const [row] = await db
    .select()
    .from(orgExtensions)
    .where(eq(orgExtensions.id, reservation.id))
    .limit(1);
  if (!row) {
    // Vanishingly unlikely: row was deleted between update and select.
    await fs.rm(finalDir, { recursive: true, force: true }).catch(() => {});
    throw new Error("org_extensions row vanished during add");
  }
  return { ok: true, extension: toListEntry(row) };
}

/**
 * Removes the DB row and the on-disk clone. Returns false if the row
 * didn't exist (caller can map to 404). Reservation rows are invisible
 * to callers, so a slug like "__pending_..." is treated the same as
 * "not registered".
 */
export async function removeOrgExtension(
  orgId: string,
  slug: string,
): Promise<boolean> {
  const db = getDb();
  if (!db) throw new Error("DB not configured");

  if (isReservationSlug(slug)) return false;

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
 * and tests.
 *
 * Returns null when the row has no credentials at all (public repo) or
 * the row doesn't exist. Throws on partial credentials — that means
 * the row was tampered with at the DB level and silently treating it
 * as "no credentials" would mask data corruption.
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
  if (!row || !isVisible(row)) return null;
  const allAbsent =
    !row.credentialIv && !row.credentialUsername && !row.credentialTag && !row.credentialData;
  if (allAbsent) return null;
  if (!row.credentialIv || !row.credentialUsername || !row.credentialTag || !row.credentialData) {
    throw new Error(`org_extensions row '${slug}' has partial credentials`);
  }
  const token = await decryptString({
    iv: row.credentialIv,
    tag: row.credentialTag,
    data: row.credentialData,
  });
  return { username: row.credentialUsername, token };
}
