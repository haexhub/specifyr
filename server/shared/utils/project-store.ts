import { and, eq, or, sql } from "drizzle-orm";
import { getDb } from "../database/client";
import {
  orgMemberships,
  projectMemberships,
  projects,
  users,
  type Project,
  type ProjectMembership,
} from "../database/schema";

/**
 * DB-backed project ownership + per-project access control.
 *
 * The filesystem (under <dataDir>/projects/<orgId>/<slug>/) remains the
 * source of truth for project CONTENT (artifacts, sessions, settings.json).
 * This module owns:
 *   - "who owns project (orgId, slug)?" — composite-key ownership row
 *   - "can user X read/modify project P?" — org-admin OR project-member
 *
 * Access rule (also enforced by the project-access middleware):
 *   - Org admin has implicit access to every project in their org.
 *   - Org members need an explicit row in `project_memberships`.
 *   - Project creators are auto-added at creation time so the creator
 *     never loses access by being a non-admin org member.
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

export async function getProjectByOrgAndSlug(
  orgId: string,
  slug: string,
): Promise<Project | null> {
  const db = getDb();
  if (!db) return null;

  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.ownerOrgId, orgId), eq(projects.slug, slug)))
    .limit(1);
  return row ?? null;
}

export async function deleteProjectFromDb(
  orgId: string,
  slug: string,
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const result = await db
    .delete(projects)
    .where(and(eq(projects.ownerOrgId, orgId), eq(projects.slug, slug)))
    .returning({ id: projects.id });
  return result.length > 0;
}

/**
 * (orgId, slug) pairs the user can access — every project where the user
 * is either an admin of the owning org OR an explicit project member.
 */
export async function listProjectKeysForUser(
  userId: string,
): Promise<{ orgId: string; slug: string }[]> {
  const db = getDb();
  if (!db) return [];

  // Two-source union via SQL: admin-of-org → all org projects; project_memberships → that project.
  const rows = await db
    .selectDistinct({ orgId: projects.ownerOrgId, slug: projects.slug })
    .from(projects)
    .leftJoin(
      orgMemberships,
      and(
        eq(orgMemberships.orgId, projects.ownerOrgId),
        eq(orgMemberships.userId, userId),
      ),
    )
    .leftJoin(
      projectMemberships,
      and(
        eq(projectMemberships.projectId, projects.id),
        eq(projectMemberships.userId, userId),
      ),
    )
    .where(
      or(
        eq(orgMemberships.role, "admin"),
        sql`${projectMemberships.userId} IS NOT NULL`,
      ),
    );
  return rows;
}

/**
 * True iff the user is an admin of the project's owning org OR an
 * explicit project member. This is the authoritative access check used
 * by the project-access middleware.
 */
export async function canUserAccessProject(
  orgId: string,
  slug: string,
  userId: string,
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const project = await getProjectByOrgAndSlug(orgId, slug);
  if (!project) return false;
  const [adminRow] = await db
    .select({ orgId: orgMemberships.orgId })
    .from(orgMemberships)
    .where(
      and(
        eq(orgMemberships.orgId, project.ownerOrgId),
        eq(orgMemberships.userId, userId),
        eq(orgMemberships.role, "admin"),
      ),
    )
    .limit(1);
  if (adminRow) return true;
  const [memberRow] = await db
    .select({ projectId: projectMemberships.projectId })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.projectId, project.id),
        eq(projectMemberships.userId, userId),
      ),
    )
    .limit(1);
  return !!memberRow;
}

export async function addProjectMember(
  projectId: string,
  userId: string,
): Promise<ProjectMembership | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .insert(projectMemberships)
    .values({ projectId, userId })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

export async function removeProjectMember(
  projectId: string,
  userId: string,
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const result = await db
    .delete(projectMemberships)
    .where(
      and(
        eq(projectMemberships.projectId, projectId),
        eq(projectMemberships.userId, userId),
      ),
    )
    .returning({ projectId: projectMemberships.projectId });
  return result.length > 0;
}

export async function listProjectMembers(
  projectId: string,
): Promise<
  { userId: string; email: string; displayName: string | null; createdAt: Date }[]
> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({
      userId: projectMemberships.userId,
      email: users.email,
      displayName: users.displayName,
      createdAt: projectMemberships.createdAt,
    })
    .from(projectMemberships)
    .innerJoin(users, eq(users.id, projectMemberships.userId))
    .where(eq(projectMemberships.projectId, projectId));
  return rows;
}
