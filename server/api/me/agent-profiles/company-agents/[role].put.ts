import { upsertAgentProfileFor } from "@su/llm-agent-profiles-store";
import { companyAgentProfileSchema, parseBody, parseParams } from "@su/validation";
import { z } from "zod";

const params = z.object({ role: z.string().trim().min(1).max(64).regex(/^[a-z0-9_-]+$/) });

export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }

  const { role } = parseParams(event, params);
  const body = await parseBody(event, companyAgentProfileSchema);
  try {
    return await upsertAgentProfileFor("user", userId, "company-agent", body, role);
  } catch (err) {
    const message = err instanceof Error ? err.message : "could not save agent profile";
    throw createError({ statusCode: 400, statusMessage: message });
  }
});
