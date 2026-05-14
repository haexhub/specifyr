import { z } from "zod";
import { loadEventStore } from "@su/specifyr-stores";
import { resolveProjectOrgId } from "@su/project-store";
import { parseParams, parseQuery, projectSlugParam } from "@su/validation";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(10_000).optional(),
});

export default defineEventHandler(async (event) => {
  const { slug } = parseParams(event, projectSlugParam);
  const { limit } = parseQuery(event, querySchema);

  // TODO(phase-3): drop DB lookup once project-access middleware sets event.context.orgId.
  const orgId = await resolveProjectOrgId(slug);
  const store = await loadEventStore(orgId, slug);
  const all = await store.list();
  // newest first, then optionally cap
  const ordered = [...all].reverse();
  return limit ? ordered.slice(0, limit) : ordered;
});
