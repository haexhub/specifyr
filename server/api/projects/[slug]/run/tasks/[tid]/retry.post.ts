import { getRunStoreModule, getActiveScheduler } from "#su/run-manager";
import { loadEventStore, dataDir } from "#su/specops-stores";

/**
 * Resets a task's status to `pending` so the next run-start picks it up again.
 * Also unblocks downstream tasks that were marked `blocked_by_upstream` because
 * of this task's previous failure.
 *
 * Refuses to touch tasks while the scheduler is actively running.
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
      statusMessage: "Run läuft gerade — erst abbrechen, dann Tasks zurücksetzen."
    });
  }

  const { RunStore } = await getRunStoreModule();
  const store = new RunStore(dataDir());
  const state = await store.getCurrent(slug);
  if (!state) throw createError({ statusCode: 404, statusMessage: "Kein Run-State" });

  const task = state.tasks[tid];
  if (!task) throw createError({ statusCode: 404, statusMessage: `Task ${tid} nicht im State` });

  // Reset this task
  state.tasks[tid] = {
    ...task,
    status: "pending",
    startedAt: null,
    completedAt: null,
    lastError: null,
    retries: (task.retries ?? 0) + 1
  };

  // Unblock any downstream that was blocked solely by this task's failure.
  // We detect: blocked_by_upstream whose lastError references this task id.
  for (const other of Object.values(state.tasks) as any[]) {
    if (other.status === "blocked_by_upstream" && String(other.lastError ?? "").includes(tid)) {
      other.status = "pending";
      other.lastError = null;
    }
  }

  // If the overall run is done, flip back to `paused` so the Start button offers "Erneut starten".
  if (state.status === "failed" || state.status === "completed") {
    state.status = "paused";
    state.completedAt = null;
  }

  await store.saveCurrent(slug, state);

  const events = await loadEventStore(slug);
  await events.append({
    type: "task_reset",
    level: "info",
    slug,
    taskId: tid,
    createdAt: new Date().toISOString(),
    title: `Task ${tid} zurückgesetzt (Retry)`
  });

  return state.tasks[tid];
});
