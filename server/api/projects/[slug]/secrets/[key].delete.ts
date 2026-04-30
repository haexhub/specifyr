import { assertProjectExists } from "@su/specops-stores";
import { deleteSecret } from "@su/secrets-store";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  const key = getRouterParam(event, "key");
  if (!slug) throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  if (!key) throw createError({ statusCode: 400, statusMessage: "Missing key" });
  await assertProjectExists(slug);

  const deleted = await deleteSecret(slug, key);
  if (!deleted) throw createError({ statusCode: 404, statusMessage: `Secret '${key}' not found` });
  return { ok: true, key };
});
