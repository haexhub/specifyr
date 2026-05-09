import { listCompanyAgentProfilesFor } from "@su/llm-agent-profiles-store";
import { requireOrgMembership } from "@su/org-auth";

export default defineEventHandler(async (event) => {
  const { org } = await requireOrgMembership(event);
  return await listCompanyAgentProfilesFor("org", org.id);
});
