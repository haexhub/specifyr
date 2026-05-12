import { getAgentProfileFor } from "@su/llm-agent-profiles-store";

export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }
  return await getAgentProfileFor("user", userId, "speckit");
});
