import { getMembership, getOrgBySlug } from "./org-store";
import { hasPermission, type OrgPermission } from "./org-permissions-store";
import type { Org, OrgMembership } from "../db/schema";

/**
 * Resolves the org identified by `:slug` in the route, asserts the
 * caller is authenticated AND a member, and returns both records.
 * Throws 401/400/404/403 as appropriate.
 */
export async function requireOrgMembership(
  event: any,
): Promise<{ userId: string; org: Org; membership: OrgMembership }> {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "slug required" });
  }
  const org = await getOrgBySlug(slug);
  if (!org) {
    throw createError({ statusCode: 404, statusMessage: "org not found" });
  }
  const membership = await getMembership(org.id, userId);
  if (!membership) {
    throw createError({ statusCode: 403, statusMessage: "not a member" });
  }
  return { userId, org, membership };
}

/**
 * Same as {@link requireOrgMembership} but additionally enforces the
 * `admin` role.
 */
export async function requireOrgAdmin(
  event: any,
): Promise<{ userId: string; org: Org; membership: OrgMembership }> {
  const ctx = await requireOrgMembership(event);
  if (ctx.membership.role !== "admin") {
    throw createError({ statusCode: 403, statusMessage: "admin only" });
  }
  return ctx;
}

/**
 * Like {@link requireOrgMembership}, but additionally enforces that the
 * caller either is an admin OR holds the named permission grant. Used
 * by endpoints (e.g. add/remove org extension) that should be open to
 * delegated members without making them full admins.
 */
export async function requireOrgPermission(
  event: any,
  permission: OrgPermission,
): Promise<{ userId: string; org: Org; membership: OrgMembership }> {
  const ctx = await requireOrgMembership(event);
  if (ctx.membership.role === "admin") return ctx;
  if (await hasPermission(ctx.org.id, ctx.userId, permission)) return ctx;
  throw createError({
    statusCode: 403,
    statusMessage: `requires permission '${permission}' or admin`,
  });
}
