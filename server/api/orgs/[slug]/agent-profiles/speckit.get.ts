import { getAgentProfileFor } from "@su/llm-agent-profiles-store";
import { requireOrgMembership } from "@su/org-auth";

export default defineEventHandler(async (event) => {
  const { org } = await requireOrgMembership(event);
  return await getAgentProfileFor("org", org.id, "speckit");
});
