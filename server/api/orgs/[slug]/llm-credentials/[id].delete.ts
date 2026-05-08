import {
  deleteCredential,
  getCredentialOwnedBy,
} from "@su/llm-credentials-store";
import { requireOrgAdmin } from "@su/org-auth";
import { orgCredentialParams, parseParams } from "@su/validation";

export default defineEventHandler(async (event) => {
  const { org } = await requireOrgAdmin(event);

  const { id } = parseParams(event, orgCredentialParams);

  const owned = await getCredentialOwnedBy(id, "org", org.id);
  if (!owned) throw createError({ statusCode: 404, statusMessage: "not found" });

  await deleteCredential(id);
  return { ok: true };
});
