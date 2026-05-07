import {
  deleteCredential,
  getCredentialOwnedBy,
} from "@su/llm-credentials-store";
import { requireOrgAdmin } from "@su/org-auth";

export default defineEventHandler(async (event) => {
  const { org } = await requireOrgAdmin(event);

  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "id required" });

  const owned = await getCredentialOwnedBy(id, "org", org.id);
  if (!owned) throw createError({ statusCode: 404, statusMessage: "not found" });

  await deleteCredential(id);
  return { ok: true };
});
