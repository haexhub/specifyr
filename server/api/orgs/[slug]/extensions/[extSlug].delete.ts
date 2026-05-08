import { requireOrgPermission } from "@su/org-auth";
import { removeOrgExtension } from "@su/org-extensions-store";
import { orgExtensionParams, parseParams } from "@su/validation";

/**
 * Remove an org extension. Requires admin or `manage_extensions` grant.
 * Drops the DB row and the on-disk clone in one go; returns 404 if the
 * slug isn't registered for this org.
 */
export default defineEventHandler(async (event) => {
  const { org } = await requireOrgPermission(event, "manage_extensions");
  const { extSlug } = parseParams(event, orgExtensionParams);

  const removed = await removeOrgExtension(org.id, extSlug);
  if (!removed) {
    throw createError({
      statusCode: 404,
      statusMessage: `extension '${extSlug}' is not registered for this org`,
    });
  }
  return { ok: true };
});
