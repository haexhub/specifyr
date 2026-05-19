import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "../database/client";
import { projects } from "../database/schema";
import { projectDir } from "./data-dirs";

/**
 * Read/write helpers for the *canonical* public spec state.
 *
 * Layout: published files live on disk under `<projectRoot>/specs/<name>`
 * and the monotonic version counter lives in `projects.spec_public_version`.
 * Disk is the source of truth for *contents*; the DB column is the
 * source of truth for "which version produced what's on disk."
 *
 * Publish (Task 1.6) writes through both, in this order:
 *   1. SELECT FOR UPDATE the projects row (locks the version).
 *   2. Verify draft.baseVersion == spec_public_version.
 *   3. Replace files on disk.
 *   4. Increment spec_public_version.
 * If step 3 throws, the DB transaction rolls back and disk is left in
 * whatever partial state filesystem ops produced. That's an accepted
 * narrow inconsistency for Phase 1 — the next publish attempt will
 * overwrite. Phase 4 may revisit with a write-ahead / temp-and-rename
 * scheme.
 */

export interface PublicSpecFile {
  name: string;
  content: string;
}

export async function getCurrentPublicVersion(
  projectId: string,
): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const [row] = await db
    .select({ v: projects.specPublicVersion })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.v ?? 0;
}

export async function readPublicSpecFiles(
  orgId: string,
  projectSlug: string,
  opts?: { name?: string },
): Promise<PublicSpecFile[]> {
  const specsDir = path.join(projectDir(orgId, projectSlug), "specs");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(specsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const results: PublicSpecFile[] = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue; // skip subdirs/symlinks
    if (opts?.name && ent.name !== opts.name) continue;
    const content = await fs.readFile(
      path.join(specsDir, ent.name),
      "utf8",
    );
    results.push({ name: ent.name, content });
  }
  // Stable order helps test assertions and diff display.
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

/**
 * Replace the file set in `<projectRoot>/specs/` with the given files.
 * Files present on disk but not in the new bundle are deleted; files
 * in the new bundle are written verbatim (existing contents overwritten).
 * Called from inside the publish transaction.
 */
export async function writePublicSpecFiles(
  orgId: string,
  projectSlug: string,
  files: PublicSpecFile[],
): Promise<void> {
  const specsDir = path.join(projectDir(orgId, projectSlug), "specs");
  await fs.mkdir(specsDir, { recursive: true });

  const desired = new Set(files.map((f) => f.name));

  // Remove obsolete files. We only look one level deep — published spec
  // bundles are flat under specs/ by convention (spec.md / plan.md / etc).
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fs.readdir(specsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!desired.has(ent.name)) {
      await fs.rm(path.join(specsDir, ent.name), { force: true });
    }
  }

  for (const f of files) {
    await fs.writeFile(path.join(specsDir, f.name), f.content, "utf8");
  }
}
