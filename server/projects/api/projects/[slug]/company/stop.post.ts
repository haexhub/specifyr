/**
 * POST /api/projects/<slug>/company/stop
 *
 * Stops the running CompanyRuntime for this project: drains the queue
 * poller, signals agents to wind down, and removes the slug from the
 * in-memory registry. After this returns, callers can `start` again to
 * boot a fresh runtime.
 *
 * Responses:
 *   200 { status: "stopped" }
 *   404 if no active company runtime is registered for the slug
 */

import {
  getActiveCompany,
  deregisterCompany,
  getCompanyNetworkModule,
  defaultCompanyNetworkPeers,
} from "@su/company-manager";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }

  const runtime = getActiveCompany(slug);
  if (!runtime) {
    throw createError({
      statusCode: 404,
      statusMessage: `No company runtime running for project '${slug}'`,
    });
  }

  await runtime.stop();
  deregisterCompany(slug);

  // Tear down the per-company docker network created at start. Best-effort:
  // if cleanup fails (network already gone, peer not connected) the helper
  // swallows the error, leaving at worst a stale entry in `docker network ls`.
  try {
    const { removeCompanyNetwork } = await getCompanyNetworkModule();
    await removeCompanyNetwork({
      companyId: slug,
      peers: defaultCompanyNetworkPeers(),
    });
  } catch { /* best-effort */ }

  return { status: "stopped", slug };
});
