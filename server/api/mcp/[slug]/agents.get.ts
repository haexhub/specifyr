/**
 * GET /api/mcp/<slug>/agents
 *
 * Returns the agent roster for the active runtime, including resolved
 * tools/skills/binaries so callers (CEO container) can answer questions
 * like "which agents can I delegate to" and "what tools does dev have".
 *
 * Auth: Bearer COMPANY_OPS_TOKEN. 401 on mismatch, 404 if no runtime.
 *
 * Response (200):
 *   { agents: [{ role, capabilities, resources, tools, skills, binaries }, ...] }
 */

import { requireRuntimeAuth } from "@su/mcp-auth";
import { parseParams, projectSlugParam } from "@su/validation";

export default defineEventHandler(async (event) => {
  const { slug } = parseParams(event, projectSlugParam);
  const runtime = await requireRuntimeAuth(event, slug);

  const agents = runtime.listAgents().map((a: any) => ({
    role: a.role,
    capabilities: a.capabilities,
    resources: a.resources ?? null,
    tools: runtime.getResolvedTools(a.role),
    skills: runtime.getResolvedSkills(a.role),
    binaries: runtime.getResolvedBinaries(a.role),
  }));

  return { slug, agents };
});
