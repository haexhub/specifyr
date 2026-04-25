import { loadStepStateStore } from "../../../utils/specops-stores";
import { getProjectStepIds } from "../../../utils/workflows";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }
  const { store } = await loadStepStateStore();
  const stepIds = await getProjectStepIds(slug);
  return store.listSteps(slug, stepIds);
});
