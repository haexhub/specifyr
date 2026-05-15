import { loadSessionStore } from "@su/specifyr-stores";

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  const stepId = getRouterParam(event, "stepId");
  if (!stepId) {
    throw createError({ statusCode: 400, statusMessage: "Missing stepId" });
  }
  const store = await loadSessionStore();
  return store.listSessions(orgId, slug, stepId);
});
