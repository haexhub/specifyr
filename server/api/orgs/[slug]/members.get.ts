import { getMembership, getOrgBySlug, listMembers } from "@su/org-store";
import { orgSlugParam, parseParams } from "@su/validation";

export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }

  const { slug } = parseParams(event, orgSlugParam);

  const org = await getOrgBySlug(slug);
  if (!org) throw createError({ statusCode: 404, statusMessage: "org not found" });

  const me = await getMembership(org.id, userId);
  if (!me) throw createError({ statusCode: 403, statusMessage: "not a member" });

  const members = await listMembers(org.id);
  return {
    org: {
      id: org.id,
      slug: org.slug,
      name: org.name,
      ownerUserId: org.ownerUserId,
      createdAt: org.createdAt,
    },
    myRole: me.role,
    members,
  };
});
