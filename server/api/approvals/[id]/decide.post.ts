/**
 * POST /api/approvals/<id>/decide
 *
 * Resolves a pending approval request. Body: `{ decision, by? }`.
 *
 * Mirrors the in-process `approvalService.resolve()` API — we just need to
 * locate the right runtime first (UUID is unique across all of them).
 *
 * 200: `{ ok: true, decision }` — the resolve succeeded.
 * 400: invalid body (missing/unknown decision).
 * 404: id not pending in any runtime.
 *
 * Security note: in v1 there's no auth — knowing the URL is enough to decide.
 * For a solo-dev tool with localhost or LAN-only deployment this is fine. If
 * exposed to the internet, gate this with a simple shared-secret header or
 * proper auth before opening the host port.
 */

import { findRuntimeByApprovalId } from "../../../utils/company-manager";

const VALID_DECISIONS = new Set(["approved", "denied", "escalated"]);

interface DecideBody {
  decision?: string;
  by?: string;
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: "Missing approval id" });
  }
  const body = await readBody<DecideBody>(event);
  if (!body || typeof body !== "object") {
    throw createError({ statusCode: 400, statusMessage: "Body must be an object" });
  }
  const decision = body.decision;
  if (typeof decision !== "string" || !VALID_DECISIONS.has(decision)) {
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid decision. Expected one of: ${[...VALID_DECISIONS].join(", ")}`,
    });
  }
  const by = typeof body.by === "string" && body.by.length > 0 ? body.by : "user";

  const found = findRuntimeByApprovalId(id);
  if (!found) {
    throw createError({
      statusCode: 404,
      statusMessage: "Approval request not found (already decided, timed out, or unknown id)",
    });
  }
  const ok = found.runtime.approvalService.resolve(id, {
    decision: decision as "approved" | "denied" | "escalated",
    by,
  });
  if (!ok) {
    // Race: gone between findRuntimeByApprovalId and resolve.
    throw createError({ statusCode: 404, statusMessage: "Approval request just resolved" });
  }
  return { ok: true, decision };
});
