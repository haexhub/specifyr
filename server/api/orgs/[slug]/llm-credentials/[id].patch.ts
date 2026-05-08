import {
  getCredentialOwnedBy,
  updateApiKeyCredential,
} from "@su/llm-credentials-store";
import { requireOrgAdmin } from "@su/org-auth";
import {
  llmCredentialPatchSchema,
  orgCredentialParams,
  parseBody,
  parseParams,
} from "@su/validation";

export default defineEventHandler(async (event) => {
  const { org } = await requireOrgAdmin(event);

  const { id } = parseParams(event, orgCredentialParams);

  const owned = await getCredentialOwnedBy(id, "org", org.id);
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
