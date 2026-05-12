import {
  getCredentialOwnedBy,
  updateApiKeyCredential,
} from "@su/llm-credentials-store";
import {
  idUuidParam,
  llmCredentialPatchSchema,
  parseBody,
  parseParams,
} from "@su/validation";

export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }

  const { id } = parseParams(event, idUuidParam);

  // Ownership check before any write — prevents one user touching
  // another user's credential id.
  const owned = await getCredentialOwnedBy(id, "user", userId);
  if (!owned) throw createError({ statusCode: 404, statusMessage: "not found" });

  const body = await parseBody(event, llmCredentialPatchSchema);

  const patch: Parameters<typeof updateApiKeyCredential>[1] = {};
  if (body.displayName !== undefined) patch.displayName = body.displayName;
  if (body.apiKey !== undefined) patch.apiKey = body.apiKey;
  if (body.baseUrl !== undefined) patch.baseUrl = body.baseUrl ?? null;
  if (body.enabled !== undefined) patch.enabled = body.enabled;

  const updated = await updateApiKeyCredential(id, patch);
  if (!updated) throw createError({ statusCode: 404, statusMessage: "not found" });
  return updated;
});
