import { upsertAgentProfileFor } from "@su/llm-agent-profiles-store";
import { parseBody, speckitAgentProfileSchema } from "@su/validation";

export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }

  const body = await parseBody(event, speckitAgentProfileSchema);
  try {
    return await upsertAgentProfileFor("user", userId, "speckit", body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "could not save agent profile";
    throw createError({ statusCode: 400, statusMessage: message });
  }
});
