import { createApiKeyCredential } from "@su/llm-credentials-store";
import { requireOrgAdmin } from "@su/org-auth";
import { llmCredentialCreateSchema, parseBody } from "@su/validation";

export default defineEventHandler(async (event) => {
  const { org } = await requireOrgAdmin(event);

  const { provider, displayName, apiKey, baseUrl } = await parseBody(
    event,
    llmCredentialCreateSchema,
  );

  try {
    return await createApiKeyCredential({
      ownerKind: "org",
      ownerId: org.id,
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
