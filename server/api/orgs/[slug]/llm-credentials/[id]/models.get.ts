import { getCredentialOwnedBy } from "@su/llm-credentials-store";
import { requireOrgMembership } from "@su/org-auth";
import { listProviderModels } from "@su/provider-models";
import { orgCredentialParams, parseParams } from "@su/validation";

export default defineEventHandler(async (event) => {
  const { org } = await requireOrgMembership(event);

  const { id } = parseParams(event, orgCredentialParams);
  const credential = await getCredentialOwnedBy(id, "org", org.id);
  if (!credential) {
    throw createError({ statusCode: 404, statusMessage: "credential not found" });
  }
  if (!credential.enabled) {
    throw createError({ statusCode: 400, statusMessage: "credential is disabled" });
  }

  const models = await listProviderModels(credential.provider, credential);
  return { provider: credential.provider, credentialId: credential.id, models };
});
