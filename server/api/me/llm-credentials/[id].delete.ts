import {
  deleteCredential,
  getCredentialOwnedBy,
} from "@su/llm-credentials-store";

export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }

  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "id required" });

  const owned = await getCredentialOwnedBy(id, "user", userId);
  if (!owned) throw createError({ statusCode: 404, statusMessage: "not found" });

  await deleteCredential(id);
  return { ok: true };
});
