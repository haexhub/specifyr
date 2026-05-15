/**
 * GET /api/projects/<slug>/company/agent-profiles
 *
 * Aggregates everything the project's company page needs to render the
 * per-role LLM picker grid: the list of roles declared in
 * `.specify/org/agents/`, plus the user-personal and project-owner-org
 * profile (if any) for each role, plus a derived "effective" pointer
 * so the UI can show what would actually run.
 *
 * Profiles themselves are owner-scoped (user or org), not project-scoped:
 * a profile for role 'developer' applies to whatever company across the
 * owner's projects has that role. The project page is just the
 * convenient place to *manage* them because that's where the role list
 * is known.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getAgentProfileFor,
  type AgentProfileSummary,
} from "@su/llm-agent-profiles-store";
import { assertProjectExists, projectCwd } from "@su/specifyr-stores";

interface AgentSpec {
  role: string;
  status?: string;
  description?: string;
  reports_to?: string;
  delivers_to?: string[];
  capabilities?: string[];
  model?: string;
}

async function loadAgentSpecs(orgId: string, projectSlug: string): Promise<Map<string, AgentSpec>> {
  const orgDir = path.join(projectCwd(orgId, projectSlug), ".specify", "org");
  const url = pathToFileURL(path.join(process.cwd(), "src/agents/spec-loader.js")).href;
  const mod = (await import(url)) as {
    loadAgents: (dir: string) => Promise<Map<string, AgentSpec>>;
  };
  try {
    return await mod.loadAgents(orgDir);
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === "ENOENT" || message.startsWith("E_MISSING_AGENTS_DIR")) {
      return new Map();
    }
    throw err;
  }
}

type ScopeLabel = "user" | "org";

interface PerRoleEntry {
  role: string;
  agent: { role: string; description?: string; declaredModel?: string; capabilities: string[] };
  userProfile: AgentProfileSummary | null;
  orgProfile: AgentProfileSummary | null;
  effective: { scope: ScopeLabel; profile: AgentProfileSummary } | null;
}

export default defineEventHandler(async (event) => {
  const ownerOrgId = event.context.orgId!;
  const ownerOrgSlug = event.context.orgSlug ?? null;
  const slug = event.context.projectSlug!;
  const userId = event.context.userId!;

  await assertProjectExists(ownerOrgId, slug);

  const specs = await loadAgentSpecs(ownerOrgId, slug);
  const roles = [...specs.keys()].sort();

  const perRole: PerRoleEntry[] = await Promise.all(
    roles.map(async (role) => {
      const agent = specs.get(role)!;
      const [userProfile, orgProfile] = await Promise.all([
        getAgentProfileFor("user", userId, "company-agent", role),
        getAgentProfileFor("org", ownerOrgId, "company-agent", role),
      ]);
      let effective: PerRoleEntry["effective"] = null;
      if (userProfile) effective = { scope: "user", profile: userProfile };
      else if (orgProfile) effective = { scope: "org", profile: orgProfile };
      return {
        role,
        agent: {
          role,
          description: agent.description,
          declaredModel: agent.model,
          capabilities: agent.capabilities ?? [],
        },
        userProfile,
        orgProfile,
        effective,
      };
    }),
  );

  return {
    slug,
    ownerOrgId,
    ownerOrgSlug,
    roles,
    perRole,
  };
});
