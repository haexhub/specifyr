import { loadStepStateStore } from "@su/specifyr-stores";
import { resolveProjectOrgId } from "@su/project-store";
import { getProjectStepIds } from "@su/workflows";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }
  // TODO(phase-3): drop DB lookup once project-access middleware sets event.context.orgId.
  const orgId = await resolveProjectOrgId(slug);
  const { store } = await loadStepStateStore();
  const stepIds = await getProjectStepIds(orgId, slug);
  return store.listSteps(slug, stepIds);
});
