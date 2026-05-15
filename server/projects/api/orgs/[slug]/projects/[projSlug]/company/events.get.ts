/**
 * GET /api/projects/<slug>/company/events
 *
 * Returns recent events from the SQLite event index for the running company
 * runtime. Used by the Runtime-View's History pane (Inkrement 13).
 *
 * Query parameters:
 *   - limit  number, default 100, max 500
 *   - since  ISO timestamp; only events with at > since
 *   - role   filter to one role
 *
 * Returns 200 with `{ events: [...] }` when the company is running, or
 * 404 when no runtime is active for this slug. (Idle is treated as 404
 * here because the index is closed; future iteration could fall back
 * to opening a read-only handle directly against state.db.)
 */

import { z } from "zod";
import { getActiveCompany } from "@su/company-manager";
import { parseQuery } from "@su/validation";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  since: z.string().min(1).optional(),
  role: z.string().min(1).max(64).optional(),
});

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;

  const runtime = getActiveCompany(orgId, slug);
  if (!runtime) {
    throw createError({ statusCode: 404, statusMessage: "Company not running" });
  }

  const { limit, since, role } = parseQuery(event, querySchema);

  const events = runtime.eventIndex.recent({ limit, since, role });
  return { slug, events };
});
