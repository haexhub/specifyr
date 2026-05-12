import { createApiKeyCredential } from "@su/llm-credentials-store";
import { llmCredentialCreateSchema, parseBody } from "@su/validation";

export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }

  const { provider, displayName, apiKey, baseUrl } = await parseBody(
    event,
    llmCredentialCreateSchema,
  );

  try {
    return await createApiKeyCredential({
      ownerKind: "user",
      ownerId: userId,
      provider,
      displayName,
      apiKey,
      baseUrl: baseUrl || undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "could not create credential";
    const status = /unique|duplicate/i.test(message) ? 409 : 400;
    throw createError({ statusCode: status, statusMessage: message });
  }
});
