import { dataDir } from "@su/data-dirs";
import {
  projectCwd,
  assertProjectExists,
  loadEventStore,
} from "@su/specifyr-stores";
import {
  getSchedulerModule,
  getTaskGraphModule,
  getRunStoreModule,
  getActiveScheduler,
  registerScheduler,
  deregisterScheduler
} from "@su/run-manager";
import { createSpeckitRunnerFactory } from "@su/speckit-agent-runner";

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  await assertProjectExists(orgId, slug);

  if (getActiveScheduler(slug)) {
    throw createError({ statusCode: 409, statusMessage: "Run already in progress" });
  }

  const pCwd = projectCwd(orgId, slug);
  const cwd = dataDir();

  // Build (or reuse) the task graph. This may call Claude once for extraction and
  // can take several seconds on first run.
  const { getOrBuildTaskGraph } = await getTaskGraphModule();
  let graph;
  try {
    graph = await getOrBuildTaskGraph({ cwd, orgId, slug, projectCwd: pCwd });
  } catch (err) {
    throw createError({
      statusCode: 400,
      statusMessage: err instanceof Error ? err.message : "Task-Graph konnte nicht erzeugt werden."
    });
  }

  const { RunStore } = await getRunStoreModule();
  const runStore = new RunStore(cwd);
  await runStore.initFromGraph(orgId, slug, graph);

  const events = await loadEventStore(orgId, slug);

  const { RunScheduler } = await getSchedulerModule();
  const runnerFactory = await createSpeckitRunnerFactory({
    userId: event.context.userId,
    ownerOrgId: orgId,
    runtimeConfig: useRuntimeConfig(),
  });
  const scheduler = new RunScheduler({ cwd, orgId, slug, projectCwd: pCwd, graph, runnerFactory });
  registerScheduler(slug, scheduler);

  const stream = createEventStream(event);

  const pushSafe = async (name: string, payload: unknown) => {
    try {
      await stream.push({ event: name, data: JSON.stringify(payload) });
    } catch {
      /* stream closed */
    }
  };

  // Bridge scheduler events into SSE + event-store
  scheduler.on("run_started", (p) => {
    pushSafe("run_started", p);
    events.append({
      type: "run_started",
      level: "info",
      slug,
      createdAt: new Date().toISOString(),
      title: "Implement-Run gestartet"
    });
  });
  scheduler.on("task_started", (p: any) => pushSafe("task_started", p));
  scheduler.on("task_chunk", (p: any) => pushSafe("task_chunk", p));
  scheduler.on("task_event", (p: any) => pushSafe("task_event", p));
  scheduler.on("task_completed", (p: any) => {
    pushSafe("task_completed", p);
    events.append({
      type: "task_completed",
      level: "success",
      slug,
      taskId: p.taskId,
      createdAt: new Date().toISOString(),
      title: `Task ${p.taskId} abgeschlossen`
    });
  });
  scheduler.on("task_failed", (p: any) => {
    pushSafe("task_failed", p);
    events.append({
      type: "task_failed",
      level: "error",
      slug,
      taskId: p.taskId,
      createdAt: new Date().toISOString(),
      title: `Task ${p.taskId} fehlgeschlagen`,
      message: p.error
    });
  });
  scheduler.on("task_blocked", (p: any) => {
    pushSafe("task_blocked", p);
    events.append({
      type: "task_blocked",
      level: "warning",
      slug,
      taskId: p.taskId,
      createdAt: new Date().toISOString(),
      title: `Task ${p.taskId} blockiert`,
      message: `Upstream-Fehler in ${p.upstream}`
    });
  });
  scheduler.on("run_paused", (p) => pushSafe("run_paused", p));
  scheduler.on("run_completed", (p: any) => {
    pushSafe("run_completed", p);
    events.append({
      type: "run_completed",
      level: p.failed > 0 ? "warning" : "success",
      slug,
      createdAt: new Date().toISOString(),
      title: `Run beendet (${p.total - p.failed}/${p.total} erfolgreich)`
    });
  });

  stream.onClosed(() => {
    // If the client disconnects but the scheduler is still running, let it finish —
    // the UI can reconnect via /status. We only cancel explicitly via /cancel endpoint.
  });

  (async () => {
    try {
      await scheduler.execute();
    } catch (err) {
      await pushSafe("error", { message: err instanceof Error ? err.message : String(err) });
    } finally {
      deregisterScheduler(slug);
      await pushSafe("done", {});
      try {
        await stream.close();
      } catch {
        /* already closed */
      }
    }
  })();

  return stream.send();
});
