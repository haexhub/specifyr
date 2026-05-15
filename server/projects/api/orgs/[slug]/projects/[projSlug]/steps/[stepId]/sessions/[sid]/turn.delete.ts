import { loadTurnBroker, assertProjectExists } from "@su/specifyr-stores";

/**
 * Cancels an in-flight turn for this session. Idempotent — returns 204 even if
 * no turn is running. The runner's subprocess is killed; the broker's error handler
 * persists any partial text and emits "turn_failed" so the client stream closes cleanly.
 */
export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  const stepId = getRouterParam(event, "stepId");
  const sid = getRouterParam(event, "sid");
  if (!stepId || !sid) {
    throw createError({ statusCode: 400, statusMessage: "Missing stepId/sid" });
  }
  await assertProjectExists(orgId, slug);

  const broker = await loadTurnBroker();
  broker.cancel(orgId, slug, stepId, sid);

  setResponseStatus(event, 204);
  return null;
});
