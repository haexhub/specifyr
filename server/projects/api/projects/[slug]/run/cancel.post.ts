import { getActiveScheduler } from "@su/run-manager";
import { loadEventStore } from "@su/specifyr-stores";
import { resolveProjectOrgId } from "@su/project-store";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }
  const scheduler = getActiveScheduler(slug);
  if (!scheduler) {
    return { slug, cancelled: false, reason: "no active run" };
  }
  scheduler.cancel();
  // TODO(phase-3): drop DB lookup once project-access middleware sets event.context.orgId.
  const orgId = await resolveProjectOrgId(slug);
  const events = await loadEventStore(orgId, slug);
  await events.append({
    type: "run_cancelled",
    level: "warning",
    slug,
    createdAt: new Date().toISOString(),
    title: "Run durch User abgebrochen"
  });
  return { slug, cancelled: true };
});
