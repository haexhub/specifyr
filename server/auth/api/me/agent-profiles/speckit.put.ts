import { upsertAgentProfileFor } from "@su/llm-agent-profiles-store";
import { parseBody, speckitAgentProfileSchema, ValidationError } from "@su/validation";

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
    // ValidationError is the sentinel store/service code uses for user-facing
    // reasons ("OAuth credential is not authorized.", "Model is required.",
    // …). Surface those as 400 with the original message so the UI can show
    // the user why the save was rejected. Anything else (DB outage, bug,
    // driver-level failure) gets logged and returned as a generic 500 so we
    // don't leak internals.
    if (err instanceof ValidationError) {
      throw createError({ statusCode: 400, statusMessage: err.message });
    }
    console.error("[speckit.put] unexpected error", err);
    throw createError({
      statusCode: 500,
      statusMessage: "could not save agent profile",
    });
  }
});
