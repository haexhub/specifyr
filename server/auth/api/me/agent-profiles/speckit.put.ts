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
    if (err && typeof err === "object" && "statusCode" in err) throw err;
    // upsertAgentProfileFor and usableCredentialForProfile throw plain Error
    // for validation issues (wrong provider/runner combo, OAuth not yet
    // authorized, etc.). Surface that message so the user actually sees why
    // the save was rejected instead of a generic 500.
    throw createError({
      statusCode: 400,
      statusMessage: err instanceof Error ? err.message : "could not save agent profile",
    });
  }
});
