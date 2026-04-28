/**
 * POST /api/mcp/<slug>/authorize
 *
 * Worker-side capability authorization. The worker container's MCP-tool
 * call lands here BEFORE the actual capability is exercised. We pass it
 * through CompanyRuntime.authorizeWithApproval which:
 *   1. checks the agent's capability grant via capability-gate
 *   2. if the cap is sensitive, blocks on CapabilityApprovalService
 *      until a user decides (or the per-agent timeout fires)
 *
 * Request body:
 *   {
 *     role: string                 caller's agent role (e.g. "ceo", "dev")
 *     capability: string           the capability being exercised
 *     taskAutonomy?: "full"|"supervised"|"interactive"
 *     requestPayload?: object      free-form context for the approver
 *   }
 *
 * Response (200):
 *   { allowed: true, approval?: {...} }
 *   { allowed: false, reason: string, approval?: {...} }
 *
 * Worker must treat allowed:false as "do not proceed". The reason string
 * tells the agent what to surface to its user-facing summary.
 *
 * Auth: Bearer token (COMPANY_OPS_TOKEN) injected into the worker by
 * the runtime's secretsResolver. Mismatch → 401.
 */

import { requireRuntimeAuth } from "../../../utils/mcp-auth";

interface AuthorizeBody {
  role?: string;
  capability?: string;
  taskAutonomy?: string;
  requestPayload?: unknown;
}

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }
  const runtime = await requireRuntimeAuth(event, slug);

  const body = await readBody<AuthorizeBody>(event);
  if (!body?.role) {
    throw createError({ statusCode: 400, statusMessage: "Missing 'role' in body" });
  }
  if (!body?.capability) {
    throw createError({ statusCode: 400, statusMessage: "Missing 'capability' in body" });
  }

  return runtime.authorizeWithApproval({
    role: body.role,
    capability: body.capability,
    taskAutonomy: body.taskAutonomy,
    requestPayload: body.requestPayload,
  });
});
