import { upsertAgentProfileFor } from "@su/llm-agent-profiles-store";
import { requireOrgAdmin } from "@su/org-auth";
import { companyAgentProfileSchema, parseBody, parseParams } from "@su/validation";
import { z } from "zod";

const params = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  role: z.string().trim().min(1).max(64).regex(/^[a-z0-9_-]+$/),
});

export default defineEventHandler(async (event) => {
  const { org } = await requireOrgAdmin(event);
  const { role } = parseParams(event, params);
  const body = await parseBody(event, companyAgentProfileSchema);

  try {
    return await upsertAgentProfileFor("org", org.id, "company-agent", body, role);
  } catch (err) {
    if (err && typeof err === "object" && "statusCode" in err) throw err;
    throw createError({
      statusCode: 500,
      statusMessage: "could not save agent profile",
    });
  }
});
