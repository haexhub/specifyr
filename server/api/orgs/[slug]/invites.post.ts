import { z } from "zod";
import { createInvite, getMembership, getOrgBySlug } from "@su/org-store";
import { orgSlugParam, parseBody, parseParams } from "@su/validation";

const inviteSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "invalid email"),
  role: z.enum(["admin", "member"]).default("member"),
});

export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }

  const { slug } = parseParams(event, orgSlugParam);

  const org = await getOrgBySlug(slug);
  if (!org) throw createError({ statusCode: 404, statusMessage: "org not found" });

  const me = await getMembership(org.id, userId);
  if (!me || me.role !== "admin") {
    throw createError({ statusCode: 403, statusMessage: "admin only" });
  }

  const { email, role } = await parseBody(event, inviteSchema);

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
