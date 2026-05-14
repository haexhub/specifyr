import { assertProjectExists } from "@su/specifyr-stores";
import { resolveProjectOrgId } from "@su/project-store";
import { deleteSecret } from "@su/secrets-store";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  const key = getRouterParam(event, "key");
  if (!slug) throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  if (!key) throw createError({ statusCode: 400, statusMessage: "Missing key" });
  // TODO(phase-3): drop DB lookup once project-access middleware sets event.context.orgId.
  const orgId = await resolveProjectOrgId(slug);
  await assertProjectExists(orgId, slug);

  const deleted = await deleteSecret(orgId, slug, key);
  if (!deleted) throw createError({ statusCode: 404, statusMessage: `Secret '${key}' not found` });
  return { ok: true, key };
});
