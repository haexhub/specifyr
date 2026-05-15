import { loadStepStateStore, loadEventStore } from "@su/specifyr-stores";

/**
 * Reverts a step from `complete` back to `in_progress` so the user can iterate
 * (and then re-mark complete when ready).
 */
export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  const stepId = getRouterParam(event, "stepId");
  if (!stepId) {
    throw createError({ statusCode: 400, statusMessage: "Missing stepId" });
  }
  const { store } = await loadStepStateStore();
  const events = await loadEventStore(orgId, slug);

  const current = await store.getStep(orgId, slug, stepId);
  const updated = await store.setStatus(
    orgId,
    slug,
    stepId,
    current.lastSessionId ? "in_progress" : "untouched"
  );

  await events.append({
    type: "step_reopened",
    level: "info",
    slug,
    stepId,
    createdAt: new Date().toISOString(),
    title: `Step '${stepId}' wieder geöffnet`
  });

  return updated;
});
