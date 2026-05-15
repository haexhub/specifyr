import { deleteOrgSecret } from "@su/secrets-store";
import { requireOrgAdmin } from "@su/org-auth";

export default defineEventHandler(async (event) => {
  const { org } = await requireOrgAdmin(event);
  const key = getRouterParam(event, "key");
  if (!key) throw createError({ statusCode: 400, statusMessage: "Missing key" });

  const deleted = await deleteOrgSecret(org.id, key);
  if (!deleted) throw createError({ statusCode: 404, statusMessage: `Secret '${key}' not found` });
  return { ok: true, key };
});
