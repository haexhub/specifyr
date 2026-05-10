import { getCredentialOwnedBy } from "@su/llm-credentials-store";
import { listProviderModels } from "@su/provider-models";
import { idUuidParam, parseParams } from "@su/validation";

export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }

  const { id } = parseParams(event, idUuidParam);
  const credential = await getCredentialOwnedBy(id, "user", userId);
  if (!credential) {
    throw createError({ statusCode: 404, statusMessage: "credential not found" });
  }
  if (!credential.enabled) {
    throw createError({ statusCode: 400, statusMessage: "credential is disabled" });
  }

  const models = await listProviderModels(credential.provider, credential);
  return { provider: credential.provider, credentialId: credential.id, models };
});
