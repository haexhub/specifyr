import { and, eq } from "drizzle-orm";
import { getDb } from "../database/client";
import {
  orgMemberPermissions,
  orgMemberships,
  type OrgMemberPermission,
} from "../database/schema";

export type OrgPermission = "manage_extensions";

/**
 * Returns true when `userId` may exercise `permission` in `orgId`.
 * Admins are blanket-allowed and short-circuit before reading the
 * permission table; non-admin members need an explicit grant row.
 * Non-members always return false.
 */
export async function hasPermission(
  orgId: string,
  userId: string,
  permission: OrgPermission,
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const [m] = await db
    .select({ role: orgMemberships.role })
    .from(orgMemberships)
    .where(
      and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)),
    )
    .limit(1);
  if (!m) return false;
  if (m.role === "admin") return true;
  const [grant] = await db
    .select({ permission: orgMemberPermissions.permission })
    .from(orgMemberPermissions)
    .where(
      and(
        eq(orgMemberPermissions.orgId, orgId),
        eq(orgMemberPermissions.userId, userId),
        eq(orgMemberPermissions.permission, permission),
      ),
    )
    .limit(1);
  return !!grant;
}

/**
 * Grants a permission to a user. Idempotent (re-grant is a no-op
 * with refreshed `granted_at`/`granted_by`). The caller is expected
 * to have already verified the grantor is an admin in the org.
 */
export async function grantPermission(input: {
  orgId: string;
  userId: string;
  permission: OrgPermission;
  grantedBy: string | null;
}): Promise<OrgMemberPermission> {
  const db = getDb();
  if (!db) throw new Error("DB not configured");

  // Cannot grant to a non-member; this would otherwise create an
  // orphaned permission row that gets revoked silently when the user
  // joins. Catch it eagerly with a meaningful error.
  const [m] = await db
    .select({ role: orgMemberships.role })
    .from(orgMemberships)
    .where(
      and(
        eq(orgMemberships.orgId, input.orgId),
        eq(orgMemberships.userId, input.userId),
      ),
    )
    .limit(1);
  if (!m) throw new Error("user is not a member of this org");

  const [row] = await db
    .insert(orgMemberPermissions)
    .values({
      orgId: input.orgId,
      userId: input.userId,
      permission: input.permission,
      grantedBy: input.grantedBy,
    })
    .onConflictDoUpdate({
      target: [
        orgMemberPermissions.orgId,
        orgMemberPermissions.userId,
        orgMemberPermissions.permission,
      ],
      set: { grantedBy: input.grantedBy, grantedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("permission upsert returned no row");
  return row;
}

export async function revokePermission(
  orgId: string,
  userId: string,
  permission: OrgPermission,
): Promise<void> {
  const db = getDb();
  if (!db) throw new Error("DB not configured");
  await db
    .delete(orgMemberPermissions)
    .where(
      and(
        eq(orgMemberPermissions.orgId, orgId),
        eq(orgMemberPermissions.userId, userId),
        eq(orgMemberPermissions.permission, permission),
      ),
    );
}

export async function listPermissions(
  orgId: string,
): Promise<OrgMemberPermission[]> {
  const db = getDb();
  if (!db) return [];
  return db
    .select()
    .from(orgMemberPermissions)
    .where(eq(orgMemberPermissions.orgId, orgId));
}

export async function listPermissionsForUser(
  orgId: string,
  userId: string,
): Promise<OrgPermission[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({ permission: orgMemberPermissions.permission })
    .from(orgMemberPermissions)
    .where(
      and(
        eq(orgMemberPermissions.orgId, orgId),
        eq(orgMemberPermissions.userId, userId),
      ),
    );
  return rows.map((r) => r.permission as OrgPermission);
}
