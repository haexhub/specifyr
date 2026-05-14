import { loadSessionStore } from "@su/specifyr-stores";
import { resolveProjectOrgId } from "@su/project-store";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  const stepId = getRouterParam(event, "stepId");
  const sid = getRouterParam(event, "sid");
  if (!slug || !stepId || !sid) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug/stepId/sid" });
  }
  // TODO(phase-3): drop DB lookup once project-access middleware sets event.context.orgId.
  const orgId = await resolveProjectOrgId(slug);
  const store = await loadSessionStore();
  const session = await store.getSession(orgId, slug, stepId, sid);
  if (!session) {
    throw createError({ statusCode: 404, statusMessage: "Session not found" });
  }
  // Clients use this to request only events they haven't seen yet from /turn/stream.
  // Without it, a fresh page load would have to ask for "since=0" and replay every event
  // ever recorded for the session.
  const lastEventSeq = await store.getLastEventSeq(orgId, slug, stepId, sid);
  return { ...session, lastEventSeq };
});
