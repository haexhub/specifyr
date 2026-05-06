import { createApiKeyCredential, type Provider } from "@su/llm-credentials-store";

const VALID_PROVIDERS: Provider[] = ["anthropic", "openai", "google"];

export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }

  const body = await readBody<{
    provider?: string;
    displayName?: string;
    apiKey?: string;
    baseUrl?: string;
    defaultModel?: string;
  }>(event);

  const provider = body?.provider as Provider | undefined;
  const displayName = body?.displayName?.trim() ?? "";
  const apiKey = body?.apiKey?.trim() ?? "";

  if (!provider || !VALID_PROVIDERS.includes(provider)) {
    throw createError({ statusCode: 400, statusMessage: "invalid provider" });
  }
  if (displayName.length < 1) {
    throw createError({ statusCode: 400, statusMessage: "displayName required" });
  }
  if (apiKey.length < 8) {
    throw createError({ statusCode: 400, statusMessage: "apiKey too short" });
  }

  try {
    return await createApiKeyCredential({
      ownerKind: "user",
      ownerId: userId,
      provider,
      displayName,
      apiKey,
      baseUrl: body?.baseUrl?.trim() || undefined,
      defaultModel: body?.defaultModel?.trim() || undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "could not create credential";
    const status = /unique|duplicate/i.test(message) ? 409 : 400;
    throw createError({ statusCode: status, statusMessage: message });
  }
});
