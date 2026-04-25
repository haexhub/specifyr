import { loadSessionStore } from "../../../../../../utils/specops-stores";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  const stepId = getRouterParam(event, "stepId");
  const sid = getRouterParam(event, "sid");
  if (!slug || !stepId || !sid) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug/stepId/sid" });
  }
  const store = await loadSessionStore();
  const session = await store.getSession(slug, stepId, sid);
  if (!session) {
    throw createError({ statusCode: 404, statusMessage: "Session not found" });
  }
  // Clients use this to request only events they haven't seen yet from /turn/stream.
  // Without it, a fresh page load would have to ask for "since=0" and replay every event
  // ever recorded for the session.
  const lastEventSeq = await store.getLastEventSeq(slug, stepId, sid);
  return { ...session, lastEventSeq };
});
