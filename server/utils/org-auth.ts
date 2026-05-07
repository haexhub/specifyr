import { getMembership, getOrgBySlug } from "./org-store";
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
