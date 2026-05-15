import { getRunStoreModule, getActiveScheduler } from "@su/run-manager";
import { dataDir } from "@su/data-dirs";
import { loadEventStore } from "@su/specifyr-stores";

/**
 * Marks a task as `skipped`. Downstream tasks that depend on it stay blocked —
 * skipped does NOT count as completed, so dependents won't auto-run.
 * Use when a task is obsolete or manually implemented outside the agent.
 */
export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  const tid = getRouterParam(event, "tid");
  if (!tid) {
    throw createError({ statusCode: 400, statusMessage: "Missing tid" });
  }

  if (getActiveScheduler(slug)) {
    throw createError({
      statusCode: 409,
      statusMessage: "Run läuft gerade — erst abbrechen, dann Tasks skippen."
    });
  }
  const { RunStore } = await getRunStoreModule();
  const store = new RunStore(dataDir());
  const state = await store.getCurrent(orgId, slug);
  if (!state) throw createError({ statusCode: 404, statusMessage: "Kein Run-State" });

  const task = state.tasks[tid];
  if (!task) throw createError({ statusCode: 404, statusMessage: `Task ${tid} nicht im State` });

  state.tasks[tid] = {
    ...task,
    status: "skipped",
    completedAt: new Date().toISOString(),
    lastError: null
  };

  await store.saveCurrent(orgId, slug, state);

  const events = await loadEventStore(orgId, slug);
  await events.append({
    type: "task_skipped",
    level: "warning",
    slug,
    taskId: tid,
    createdAt: new Date().toISOString(),
    title: `Task ${tid} übersprungen`
  });

  return state.tasks[tid];
});
