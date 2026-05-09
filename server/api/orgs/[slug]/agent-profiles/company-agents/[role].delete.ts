import { deleteAgentProfileFor } from "@su/llm-agent-profiles-store";
import { requireOrgAdmin } from "@su/org-auth";
import { parseParams } from "@su/validation";
import { z } from "zod";

const params = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  role: z.string().trim().min(1).max(64).regex(/^[a-z0-9_-]+$/),
});

export default defineEventHandler(async (event) => {
  const { org } = await requireOrgAdmin(event);
  const { role } = parseParams(event, params);
  await deleteAgentProfileFor("org", org.id, "company-agent", role);
  setResponseStatus(event, 204);
  return null;
});
