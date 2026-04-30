import { loadTurnBroker, assertProjectExists } from "#su/specops-stores";

/**
 * Cancels an in-flight turn for this session. Idempotent — returns 204 even if
 * no turn is running. The runner's subprocess is killed; the broker's error handler
 * persists any partial text and emits "turn_failed" so the client stream closes cleanly.
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
  broker.cancel(slug, stepId, sid);

  setResponseStatus(event, 204);
  return null;
});
