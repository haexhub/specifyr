import { loadStepStateStore, loadEventStore } from "@su/specops-stores";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  const stepId = getRouterParam(event, "stepId");
  if (!slug || !stepId) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug/stepId" });
  }

  const body = await readBody<{ sessionId?: string }>(event);

  const { store } = await loadStepStateStore();
  const events = await loadEventStore(slug);

  const updated = await store.markComplete(slug, stepId, body?.sessionId ?? null);

  await events.append({
    type: "step_marked_complete",
    level: "success",
    slug,
    stepId,
    sessionId: body?.sessionId,
    createdAt: new Date().toISOString(),
    title: `Step '${stepId}' als erledigt markiert`
  });

  return updated;
});
