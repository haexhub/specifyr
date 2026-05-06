import { createInvite, getMembership, getOrgBySlug } from "@su/org-store";

export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }

  const slug = getRouterParam(event, "slug");
  if (!slug) throw createError({ statusCode: 400, statusMessage: "slug required" });

  const org = await getOrgBySlug(slug);
  if (!org) throw createError({ statusCode: 404, statusMessage: "org not found" });

  const me = await getMembership(org.id, userId);
  if (!me || me.role !== "admin") {
    throw createError({ statusCode: 403, statusMessage: "admin only" });
  }

  const body = await readBody<{ email?: string; role?: "admin" | "member" }>(event);
  const email = body?.email?.trim().toLowerCase() ?? "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw createError({ statusCode: 400, statusMessage: "invalid email" });
  }
  const role = body?.role === "admin" ? "admin" : "member";

  const invite = await createInvite({
    orgId: org.id,
    invitedEmail: email,
    invitedRole: role,
    createdBy: userId,
  });

  // Caller-relative URL — frontend resolves against origin so the link
  // works behind whatever traefik is exposing this instance as.
  return {
    token: invite.token,
    invitedEmail: invite.invitedEmail,
    invitedRole: invite.invitedRole,
    expiresAt: invite.expiresAt,
    acceptPath: `/invites/${invite.token}`,
  };
});
