import { loadStepStateStore, loadEventStore } from "@su/specifyr-stores";
import { resolveProjectOrgId } from "@su/project-store";

/**
 * Reverts a step from `complete` back to `in_progress` so the user can iterate
 * (and then re-mark complete when ready).
 */
export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  const stepId = getRouterParam(event, "stepId");
  if (!slug || !stepId) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug/stepId" });
  }

  // TODO(phase-3): drop DB lookup once project-access middleware sets event.context.orgId.
  const orgId = await resolveProjectOrgId(slug);
  const { store } = await loadStepStateStore();
  const events = await loadEventStore(orgId, slug);

  const current = await store.getStep(slug, stepId);
  const updated = await store.setStatus(
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
