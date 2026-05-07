import { and, eq, inArray, or } from "drizzle-orm";
import { getDb } from "../db/client";
import { orgMemberships, projects, type Project } from "../db/schema";

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
 * Slugs of projects the user can access: directly owned
 * (owner_kind='user') OR owned by an org the user is a member of.
 */
export async function listProjectSlugsForUser(userId: string): Promise<string[]> {
  const db = getDb();
  if (!db) return [];

  // Two-step rather than a join so the SQL stays trivially readable:
  // (1) find the user's org ids, (2) match projects against
  // user-owned OR (org-owned AND in those org ids).
  const memberships = await db
    .select({ orgId: orgMemberships.orgId })
    .from(orgMemberships)
    .where(eq(orgMemberships.userId, userId));
  const orgIds = memberships.map((m) => m.orgId);

  const userOwnedFilter = and(
    eq(projects.ownerKind, "user"),
    eq(projects.ownerId, userId),
  );
  const filter = orgIds.length === 0
    ? userOwnedFilter
    : or(
        userOwnedFilter,
        and(eq(projects.ownerKind, "org"), inArray(projects.ownerId, orgIds)),
      );

  const rows = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(filter);
  return rows.map((r) => r.slug);
}

/**
 * True iff the user can access the project: either owns it directly
 * or is a member of the owning org.
 */
export async function userOwnsProject(slug: string, userId: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const project = await getProjectFromDb(slug);
  if (!project) return false;
  if (project.ownerKind === "user") return project.ownerId === userId;
  // org-owned: check membership
  const [m] = await db
    .select({ orgId: orgMemberships.orgId })
    .from(orgMemberships)
    .where(
      and(
        eq(orgMemberships.orgId, project.ownerId),
        eq(orgMemberships.userId, userId),
      ),
    )
    .limit(1);
  return !!m;
}
