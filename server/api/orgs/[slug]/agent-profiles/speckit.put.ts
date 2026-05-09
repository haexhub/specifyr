import { upsertAgentProfileFor } from "@su/llm-agent-profiles-store";
import { requireOrgAdmin } from "@su/org-auth";
import { parseBody, speckitAgentProfileSchema } from "@su/validation";

export default defineEventHandler(async (event) => {
  const { org } = await requireOrgAdmin(event);
  const body = await parseBody(event, speckitAgentProfileSchema);

  try {
    return await upsertAgentProfileFor("org", org.id, "speckit", body);
  } catch (err) {
    if (err && typeof err === "object" && "statusCode" in err) throw err;
    throw createError({
      statusCode: 500,
      statusMessage: "could not save agent profile",
    });
  }
});
