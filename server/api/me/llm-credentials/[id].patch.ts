import {
  getCredentialOwnedBy,
  updateApiKeyCredential,
} from "@su/llm-credentials-store";

export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }

  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "id required" });

  // Ownership check before any write — prevents one user touching
  // another user's credential id.
  const owned = await getCredentialOwnedBy(id, "user", userId);
  if (!owned) throw createError({ statusCode: 404, statusMessage: "not found" });

  const body = await readBody<{
    displayName?: string;
    apiKey?: string;
    baseUrl?: string | null;
    enabled?: boolean;
  }>(event);

  const patch: Parameters<typeof updateApiKeyCredential>[1] = {};
  if (body.displayName !== undefined) patch.displayName = body.displayName.trim();
  if (body.apiKey !== undefined) {
    const trimmed = body.apiKey.trim();
    if (trimmed.length < 8) {
      throw createError({ statusCode: 400, statusMessage: "apiKey too short" });
    }
    patch.apiKey = trimmed;
  }
  if (body.baseUrl !== undefined) {
    patch.baseUrl = body.baseUrl ? body.baseUrl.trim() : null;
  }
  if (body.enabled !== undefined) patch.enabled = body.enabled;

  const updated = await updateApiKeyCredential(id, patch);
  if (!updated) throw createError({ statusCode: 404, statusMessage: "not found" });
  return updated;
});
