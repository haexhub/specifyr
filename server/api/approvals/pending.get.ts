/**
 * GET /api/approvals/pending
 *
 * Lists every pending approval request across all running CompanyRuntimes.
 * Used by the approvals UI overview (and could feed an in-runtime-view widget
 * later).
 *
 * Returns: `{ approvals: Array<{requestId, slug, orgSlug, agent, capability}> }`.
 *
 * The orgSlug is included so the UI can build the /specs/<orgSlug>/<projSlug>
 * deep-link. Approval-IDs are UUIDs — collision-safe across runtimes.
 */

import { listActiveCompanies } from "@su/company-manager";

export default defineEventHandler(() => {
  const all = listActiveCompanies().flatMap((entry) =>
    entry.runtime.approvalService.listPending().map((p) => ({
      requestId: p.requestId,
      slug: entry.slug,
      orgSlug: entry.orgSlug,
      agent: p.agent,
      capability: p.capability,
    })),
  );
  return { approvals: all };
});
