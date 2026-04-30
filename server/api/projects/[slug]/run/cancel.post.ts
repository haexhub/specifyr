import { getActiveScheduler } from "#su/run-manager";
import { loadEventStore } from "#su/specops-stores";

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
  const events = await loadEventStore(slug);
  await events.append({
    type: "run_cancelled",
    level: "warning",
    slug,
    createdAt: new Date().toISOString(),
    title: "Run durch User abgebrochen"
  });
  return { slug, cancelled: true };
});
