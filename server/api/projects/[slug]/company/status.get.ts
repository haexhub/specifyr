/**
 * GET /api/projects/<slug>/company/status
 *
 * Returns the current state of the company runtime for this project:
 *   - status: "running" while a runtime is registered, "idle" otherwise
 *   - agents: roster snapshot (role, capabilities, resources) when running
 *   - queueDepth: number of task YAMLs waiting in the queue dir
 *
 * "Idle" is not an error — it's the resting state before /start. Callers
 * that need authoritative liveness should treat 404 differently from idle.
 */

import { getActiveCompany } from "#su/company-manager";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }

  const runtime = getActiveCompany(slug);
  if (!runtime) {
    return { status: "idle", slug };
  }

  return { slug, ...runtime.getStatus() };
});
