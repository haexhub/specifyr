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

import { getActiveCompany } from "#su/company-manager";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }

  const runtime = getActiveCompany(slug);
  if (!runtime) {
    throw createError({ statusCode: 404, statusMessage: "Company not running" });
  }

  const query = getQuery(event);
  const limitRaw = Number(query.limit ?? 100);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;
  const since = typeof query.since === "string" ? query.since : undefined;
  const role = typeof query.role === "string" ? query.role : undefined;

  const events = runtime.eventIndex.recent({ limit, since, role });
  return { slug, events };
});
