import {
  deleteCredential,
  getCredentialOwnedBy,
} from "@su/llm-credentials-store";
import { getClaudeOAuthDriver } from "@su/claude-oauth-driver";
import { requireOrgAdmin } from "@su/org-auth";
import { orgCredentialParams, parseParams } from "@su/validation";

/**
 * Aborts an in-flight org OAuth flow. Admin-only — same authority
 * level as starting one. Idempotent on the subprocess side.
 */
export default defineEventHandler(async (event) => {
  const { org } = await requireOrgAdmin(event);
  const { id } = parseParams(event, orgCredentialParams);

  const owned = await getCredentialOwnedBy(id, "org", org.id);
  if (!owned) throw createError({ statusCode: 404, statusMessage: "not found" });
  if (owned.oauthStatus !== "pending") {
    throw createError({
      statusCode: 409,
      statusMessage:
        "credential is no longer pending — use DELETE on /api/orgs/:slug/llm-credentials/:id instead",
    });
  }

  try {
    getClaudeOAuthDriver().cancel(id);
  } catch {
    /* not in memory */
  }
  await deleteCredential(id);
  return { ok: true };
});
