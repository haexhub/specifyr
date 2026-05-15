import { z } from "zod";
import { loadEventStore } from "@su/specifyr-stores";
import { parseQuery } from "@su/validation";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(10_000).optional(),
});

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  const { limit } = parseQuery(event, querySchema);

  const store = await loadEventStore(orgId, slug);
  const all = await store.list();
  // newest first, then optionally cap
  const ordered = [...all].reverse();
  return limit ? ordered.slice(0, limit) : ordered;
});
