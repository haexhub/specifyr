import { getAgentProfileFor } from "@su/llm-agent-profiles-store";
import { requireOrgMembership } from "@su/org-auth";
import { parseParams } from "@su/validation";
import { z } from "zod";

const params = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  role: z.string().trim().min(1).max(64).regex(/^[a-z0-9_-]+$/),
});

export default defineEventHandler(async (event) => {
  const { org } = await requireOrgMembership(event);
  const { role } = parseParams(event, params);
  return await getAgentProfileFor("org", org.id, "company-agent", role);
});
