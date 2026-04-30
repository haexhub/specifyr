/**
 * GET /api/approvals/pending
 *
 * Lists every pending approval request across all running CompanyRuntimes.
 * Used by the approvals UI overview (and could feed an in-runtime-view widget
 * later).
 *
 * Returns: `{ approvals: Array<{requestId, slug, agent, capability}> }`.
 *
 * The slug is included per-row so the UI can deep-link or filter even though
 * the URL itself is slug-free. Approval-IDs are UUIDs — collision-safe across
 * runtimes.
 */

import { listActiveCompanies } from "@su/company-manager";

export default defineEventHandler(() => {
  const all = listActiveCompanies().flatMap(([slug, runtime]) =>
    runtime.approvalService.listPending().map((p) => ({
      requestId: p.requestId,
      slug,
      agent: p.agent,
      capability: p.capability,
    })),
  );
  return { approvals: all };
});
