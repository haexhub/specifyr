import { loadSessionStore } from "#su/specops-stores";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  const stepId = getRouterParam(event, "stepId");
  if (!slug || !stepId) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug/stepId" });
  }
  const store = await loadSessionStore();
  return store.listSessions(slug, stepId);
});
