import { loadSessionStore } from "@su/specifyr-stores";
import { resolveProjectOrgId } from "@su/project-store";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  const stepId = getRouterParam(event, "stepId");
  if (!slug || !stepId) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug/stepId" });
  }
  // TODO(phase-3): drop DB lookup once project-access middleware sets event.context.orgId.
  const orgId = await resolveProjectOrgId(slug);
  const store = await loadSessionStore();
  return store.listSessions(orgId, slug, stepId);
});
