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

import { z } from "zod";
import { findRuntimeByApprovalId } from "@su/company-manager";
import { idUuidParam, parseBody, parseParams } from "@su/validation";

const decideSchema = z.object({
  decision: z.enum(["approved", "denied", "escalated"]),
  by: z.string().trim().min(1).max(256).optional(),
});

export default defineEventHandler(async (event) => {
  const { id } = parseParams(event, idUuidParam);
  const { decision, by } = await parseBody(event, decideSchema);
  const decidedBy = by && by.length > 0 ? by : "user";

  const found = findRuntimeByApprovalId(id);
  if (!found) {
    throw createError({
      statusCode: 404,
      statusMessage: "Approval request not found (already decided, timed out, or unknown id)",
    });
  }
  const ok = found.runtime.approvalService.resolve(id, {
    decision,
    by: decidedBy,
  });
  if (!ok) {
    // Race: gone between findRuntimeByApprovalId and resolve.
    throw createError({ statusCode: 404, statusMessage: "Approval request just resolved" });
  }
  return { ok: true, decision };
});
