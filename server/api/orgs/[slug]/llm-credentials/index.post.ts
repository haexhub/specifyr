import { createApiKeyCredential, type Provider } from "@su/llm-credentials-store";
import { requireOrgAdmin } from "@su/org-auth";

const VALID_PROVIDERS: Provider[] = ["anthropic", "openai", "google", "openrouter"];

export default defineEventHandler(async (event) => {
  const { org } = await requireOrgAdmin(event);

  const body = await readBody<{
    provider?: string;
    displayName?: string;
    apiKey?: string;
    baseUrl?: string;
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
      ownerKind: "org",
      ownerId: org.id,
      provider,
      displayName,
      apiKey,
      baseUrl: body?.baseUrl?.trim() || undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "could not create credential";
    const status = /unique|duplicate/i.test(message) ? 409 : 400;
    throw createError({ statusCode: status, statusMessage: message });
  }
});
