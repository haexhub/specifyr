import { getActiveScheduler } from "@su/run-manager";
import { loadEventStore } from "@su/specifyr-stores";

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  const scheduler = getActiveScheduler(orgId, slug);
  if (!scheduler) {
    return { slug, cancelled: false, reason: "no active run" };
  }
  scheduler.cancel();
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
