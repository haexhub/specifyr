import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client";
import { projects, type Project } from "../db/schema";

/**
 * DB-backed project ownership.
 *
 * The filesystem (under <dataDir>/projects/<slug>/) remains the source
 * of truth for project CONTENT (artifacts, sessions, settings.json).
 * This module owns the question "who owns project <slug>?" — used by
 * the auth layer to gate access.
 *
 * Every function returns null/empty when DATABASE_URL is unset, so
 * callers can safely fall back to legacy single-user behavior.
 */

export type ProjectOwner = { kind: "user" | "org"; id: string };

export async function recordProjectOwnership(
  slug: string,
  owner: ProjectOwner,
): Promise<Project | null> {
  const db = getDb();
  if (!db) return null;

  const [row] = await db
    .insert(projects)
    .values({ slug, ownerKind: owner.kind, ownerId: owner.id })
    .returning();
  return row;
}

export async function getProjectFromDb(slug: string): Promise<Project | null> {
  const db = getDb();
  if (!db) return null;

  const [row] = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  return row ?? null;
}

/**
 * Slugs of projects the user owns directly (owner_kind='user'). Org-owned
 * projects come from a separate query once the orgs phase lands.
 */
export async function listProjectSlugsForUser(userId: string): Promise<string[]> {
  const db = getDb();
  if (!db) return [];

  const rows = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(and(eq(projects.ownerKind, "user"), eq(projects.ownerId, userId)));
  return rows.map((r) => r.slug);
}

/**
 * True iff the user owns the project directly. Org membership checks
 * land in phase 3.
 */
export async function userOwnsProject(slug: string, userId: string): Promise<boolean> {
  const project = await getProjectFromDb(slug);
  if (!project) return false;
  return project.ownerKind === "user" && project.ownerId === userId;
}
