import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../database/client";
import { orgMemberships, projects, type Project } from "../database/schema";

/**
 * DB-backed project ownership.
 *
 * The filesystem (under <dataDir>/projects/<slug>/) remains the source
 * of truth for project CONTENT (artifacts, sessions, settings.json).
 * This module owns the question "who owns project <slug>?" — used by
 * the auth layer to gate access.
 *
 * Mandatory-org model: every project belongs to exactly one org. There
 * is no per-user ownership. The "personal" workspace is a single-member
 * org with the user as owner. Access is gated by membership in
 * `owner_org_id`.
 *
 * Every function returns null/empty when DATABASE_URL is unset, so
 * callers can safely fall back to legacy single-user behavior in dev.
 */

export type ProjectOwner = { ownerOrgId: string };

export async function recordProjectOwnership(
  slug: string,
  owner: ProjectOwner,
): Promise<Project | null> {
  const db = getDb();
  if (!db) return null;

  const [row] = await db
    .insert(projects)
    .values({ slug, ownerOrgId: owner.ownerOrgId })
    .returning();
  return row ?? null;
}

export async function getProjectFromDb(slug: string): Promise<Project | null> {
  const db = getDb();
  if (!db) return null;

  const [row] = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  return row ?? null;
}

// TODO(phase-3): drop once project-access middleware populates event.context.orgId.
// Slugs are no longer globally unique — this is a transitional helper that
// resolves an owner orgId from a slug via DB lookup. Throws 404 if unknown.
export async function resolveProjectOrgId(slug: string): Promise<string> {
  const project = await getProjectFromDb(slug);
  if (!project) {
    throw createError({
      statusCode: 404,
      statusMessage: `Project not found: ${slug}`,
    });
  }
  return project.ownerOrgId;
}

/**
 * Slugs of projects the user can access — every project owned by an org
 * the user is a member of.
 */
export async function listProjectSlugsForUser(
  userId: string,
): Promise<string[]> {
  const db = getDb();
  if (!db) return [];

  const memberships = await db
    .select({ orgId: orgMemberships.orgId })
    .from(orgMemberships)
    .where(eq(orgMemberships.userId, userId));
  const orgIds = memberships.map((m) => m.orgId);
  if (orgIds.length === 0) return [];

  const rows = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(inArray(projects.ownerOrgId, orgIds));
  return rows.map((r) => r.slug);
}

/**
 * True iff the user is a member of the project's owning org.
 */
export async function userOwnsProject(
  slug: string,
  userId: string,
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const project = await getProjectFromDb(slug);
  if (!project) return false;
  const [m] = await db
    .select({ orgId: orgMemberships.orgId })
    .from(orgMemberships)
    .where(
      and(
        eq(orgMemberships.orgId, project.ownerOrgId),
        eq(orgMemberships.userId, userId),
      ),
    )
    .limit(1);
  return !!m;
}
