import { getMembership, getOrgBySlug, listMembers } from "@su/org-store";

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
  if (!me) throw createError({ statusCode: 403, statusMessage: "not a member" });

  const members = await listMembers(org.id);
  return {
    org: { id: org.id, slug: org.slug, name: org.name, createdAt: org.createdAt },
    myRole: me.role,
    members,
  };
});
