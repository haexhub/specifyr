import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  orgInvites,
  orgMemberships,
  orgs,
  users,
  type Org,
  type OrgInvite,
  type OrgMembership,
} from "../db/schema";

export type OrgWithRole = Org & { role: OrgMembership["role"] };

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 64);
}

/**
 * Creates an org and assigns the creator as admin in a single
 * transaction so we can never end up with an org that has no admins.
 */
export async function createOrgWithAdmin(
  name: string,
  creatorUserId: string,
): Promise<Org> {
  const db = getDb();
  if (!db) throw new Error("DB not configured");

  const slug = slugify(name);
  if (!slug) throw new Error("name does not produce a valid slug");

  return db.transaction(async (tx) => {
    const [org] = await tx
      .insert(orgs)
      .values({ slug, name: name.trim(), createdBy: creatorUserId })
      .returning();
    await tx.insert(orgMemberships).values({
      orgId: org.id,
      userId: creatorUserId,
      role: "admin",
    });
    return org;
  });
}

export async function listOrgsForUser(userId: string): Promise<OrgWithRole[]> {
  const db = getDb();
  if (!db) return [];

  const rows = await db
    .select({
      id: orgs.id,
      slug: orgs.slug,
      name: orgs.name,
      createdBy: orgs.createdBy,
      createdAt: orgs.createdAt,
      role: orgMemberships.role,
    })
    .from(orgs)
    .innerJoin(orgMemberships, eq(orgMemberships.orgId, orgs.id))
    .where(eq(orgMemberships.userId, userId))
    .orderBy(desc(orgs.createdAt));
  return rows;
}

export async function getOrgBySlug(slug: string): Promise<Org | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db.select().from(orgs).where(eq(orgs.slug, slug)).limit(1);
  return row ?? null;
}

export async function getMembership(
  orgId: string,
  userId: string,
): Promise<OrgMembership | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
    .limit(1);
  return row ?? null;
}

export type MemberRow = {
  userId: string;
  email: string;
  displayName: string | null;
  role: OrgMembership["role"];
  joinedAt: Date;
};

export async function listMembers(orgId: string): Promise<MemberRow[]> {
  const db = getDb();
  if (!db) return [];
  return db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      role: orgMemberships.role,
      joinedAt: orgMemberships.createdAt,
    })
    .from(orgMemberships)
    .innerJoin(users, eq(users.id, orgMemberships.userId))
    .where(eq(orgMemberships.orgId, orgId));
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function createInvite(input: {
  orgId: string;
  invitedEmail: string;
  invitedRole: "admin" | "member";
  createdBy: string;
}): Promise<OrgInvite> {
  const db = getDb();
  if (!db) throw new Error("DB not configured");

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const [row] = await db
    .insert(orgInvites)
    .values({
      token,
      orgId: input.orgId,
      invitedEmail: input.invitedEmail.toLowerCase(),
      invitedRole: input.invitedRole,
      createdBy: input.createdBy,
      expiresAt,
    })
    .returning();
  return row;
}

export async function listOpenInvites(orgId: string): Promise<OrgInvite[]> {
  const db = getDb();
  if (!db) return [];
  return db
    .select()
    .from(orgInvites)
    .where(
      and(
        eq(orgInvites.orgId, orgId),
        isNull(orgInvites.acceptedAt),
        isNull(orgInvites.revokedAt),
      ),
    )
    .orderBy(desc(orgInvites.createdAt));
}

export type AcceptResult =
  | { ok: true; orgId: string; orgSlug: string; role: "admin" | "member" }
  | { ok: false; reason: "not_found" | "expired" | "already_used" | "revoked" };

/**
 * Atomically marks the invite accepted and inserts/updates membership.
 * The recipient identity is the authenticated user — we don't trust
 * the email field for redemption (it's display-only).
 */
export async function acceptInvite(
  token: string,
  acceptingUserId: string,
): Promise<AcceptResult> {
  const db = getDb();
  if (!db) throw new Error("DB not configured");

  return db.transaction(async (tx) => {
    const [invite] = await tx
      .select()
      .from(orgInvites)
      .where(eq(orgInvites.token, token))
      .limit(1);
    if (!invite) return { ok: false as const, reason: "not_found" as const };
    if (invite.acceptedAt) return { ok: false as const, reason: "already_used" as const };
    if (invite.revokedAt) return { ok: false as const, reason: "revoked" as const };
    if (invite.expiresAt.getTime() < Date.now())
      return { ok: false as const, reason: "expired" as const };

    await tx
      .insert(orgMemberships)
      .values({
        orgId: invite.orgId,
        userId: acceptingUserId,
        role: invite.invitedRole,
      })
      .onConflictDoUpdate({
        target: [orgMemberships.orgId, orgMemberships.userId],
        set: { role: invite.invitedRole },
      });

    await tx
      .update(orgInvites)
      .set({ acceptedAt: new Date() })
      .where(eq(orgInvites.token, token));

    const [org] = await tx.select().from(orgs).where(eq(orgs.id, invite.orgId)).limit(1);
    return {
      ok: true as const,
      orgId: invite.orgId,
      orgSlug: org.slug,
      role: invite.invitedRole,
    };
  });
}

export async function revokeInvite(token: string): Promise<void> {
  const db = getDb();
  if (!db) throw new Error("DB not configured");
  await db
    .update(orgInvites)
    .set({ revokedAt: new Date() })
    .where(eq(orgInvites.token, token));
}
