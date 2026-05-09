import { getAgentProfileFor } from "@su/llm-agent-profiles-store";
import { parseParams } from "@su/validation";
import { z } from "zod";

const params = z.object({ role: z.string().trim().min(1).max(64).regex(/^[a-z0-9_-]+$/) });

export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }
  const { role } = parseParams(event, params);
  return await getAgentProfileFor("user", userId, "company-agent", role);
});
