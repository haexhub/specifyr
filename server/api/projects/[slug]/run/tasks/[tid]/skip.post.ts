import { getRunStoreModule, getActiveScheduler } from "../../../../../../utils/run-manager";
import { loadEventStore, dataDir } from "../../../../../../utils/specops-stores";

/**
 * Marks a task as `skipped`. Downstream tasks that depend on it stay blocked —
 * skipped does NOT count as completed, so dependents won't auto-run.
 * Use when a task is obsolete or manually implemented outside the agent.
 */
export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  const tid = getRouterParam(event, "tid");
  if (!slug || !tid) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug/tid" });
  }

  if (getActiveScheduler(slug)) {
    throw createError({
      statusCode: 409,
      statusMessage: "Run läuft gerade — erst abbrechen, dann Tasks skippen."
    });
  }

  const { RunStore } = await getRunStoreModule();
  const store = new RunStore(dataDir());
  const state = await store.getCurrent(slug);
  if (!state) throw createError({ statusCode: 404, statusMessage: "Kein Run-State" });

  const task = state.tasks[tid];
  if (!task) throw createError({ statusCode: 404, statusMessage: `Task ${tid} nicht im State` });

  state.tasks[tid] = {
    ...task,
    status: "skipped",
    completedAt: new Date().toISOString(),
    lastError: null
  };

  await store.saveCurrent(slug, state);

  const events = await loadEventStore(slug);
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
