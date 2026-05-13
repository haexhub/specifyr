import {
  loadSessionStore,
  loadTurnBroker,
  assertProjectExists,
} from "@su/specifyr-stores";

/**
 * Removes the session's meta + messages + events from disk. If a turn is
 * currently running for the session we cancel it first — the broker's
 * "finally" cleanup releases the running flag and the runner subprocess
 * exits before we delete files, so we don't race a write against rm().
 */
export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  const stepId = getRouterParam(event, "stepId");
  const sid = getRouterParam(event, "sid");
  if (!slug || !stepId || !sid) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug/stepId/sid" });
  }

  await assertProjectExists(slug);

  const broker = await loadTurnBroker();
  if (broker.isRunning(slug, stepId, sid)) {
    broker.cancel(slug, stepId, sid);
    // cancel() only signals the runner; the broker's catch+finally still writes
    // turn_failed / updateSessionMeta to disk before clearing `running`. Poll
    // until that's done so we don't rm files mid-write.
    const deadline = Date.now() + 5000;
    while (broker.isRunning(slug, stepId, sid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (broker.isRunning(slug, stepId, sid)) {
      throw createError({
        statusCode: 503,
        statusMessage: "Turn cancellation timed out — please retry",
      });
    }
  }

  const store = await loadSessionStore();
  const existed = await store.deleteSession(slug, stepId, sid);
  if (!existed) {
    throw createError({ statusCode: 404, statusMessage: "Session not found" });
  }

  setResponseStatus(event, 204);
  return null;
});
