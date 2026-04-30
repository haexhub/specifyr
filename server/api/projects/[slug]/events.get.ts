import { loadEventStore } from "@su/specops-stores";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }
  const q = getQuery(event);
  const limitParam = typeof q.limit === "string" ? Number.parseInt(q.limit, 10) : undefined;
  const limit = Number.isFinite(limitParam) && limitParam! > 0 ? limitParam : undefined;

  const store = await loadEventStore(slug);
  const all = await store.list();
  // newest first, then optionally cap
  const ordered = [...all].reverse();
  return limit ? ordered.slice(0, limit) : ordered;
});
