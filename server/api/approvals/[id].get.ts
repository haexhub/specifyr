/**
 * GET /api/approvals/<id>
 *
 * Fetches the details of one pending approval request, by request-id. The
 * id is a UUID, globally unique across runtimes — no slug needed in the URL.
 *
 * 200: `{ requestId, slug, agent, capability }`
 * 404: id not found in any active runtime (already resolved, timed out, or
 *      never existed). The UI shows "bereits entschieden / unbekannt" — we
 *      don't distinguish, because the runtime doesn't keep resolved entries
 *      around (the JSONL event log does, but querying it is out of scope for
 *      this slice).
 */

import { findRuntimeByApprovalId } from "@su/company-manager";

export default defineEventHandler((event) => {
  const id = getRouterParam(event, "id");
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: "Missing approval id" });
  }
  const found = findRuntimeByApprovalId(id);
  if (!found) {
    throw createError({
      statusCode: 404,
      statusMessage: "Approval request not found (already decided, timed out, or unknown id)",
    });
  }
  const entry = found.runtime.approvalService
    .listPending()
    .find((p) => p.requestId === id);
  if (!entry) {
    // Race: was pending when findRuntimeByApprovalId saw it, gone now.
    throw createError({ statusCode: 404, statusMessage: "Approval request just resolved" });
  }
  return {
    requestId: entry.requestId,
    slug: found.slug,
    agent: entry.agent,
    capability: entry.capability,
  };
});
