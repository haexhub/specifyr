import { assertProjectExists } from "@su/specifyr-stores";
import { deleteSecret } from "@su/secrets-store";

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  const key = getRouterParam(event, "key");
  if (!key) throw createError({ statusCode: 400, statusMessage: "Missing key" });
  await assertProjectExists(orgId, slug);

  const deleted = await deleteSecret(orgId, slug, key);
  if (!deleted) throw createError({ statusCode: 404, statusMessage: `Secret '${key}' not found` });
  return { ok: true, key };
});
