import {
  deleteCredential,
  getCredentialOwnedBy,
} from "@su/llm-credentials-store";
import { getClaudeOAuthDriver } from "@su/claude-oauth-driver";
import { idUuidParam, parseParams } from "@su/validation";

/**
 * Aborts an in-flight OAuth flow. Kills the held-open subprocess and
 * deletes the placeholder DB row. Idempotent: callable from the UI's
 * "Cancel" button OR a "user navigated away" cleanup.
 */
export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }
  const { id } = parseParams(event, idUuidParam);

  const owned = await getCredentialOwnedBy(id, "user", userId);
  if (!owned) throw createError({ statusCode: 404, statusMessage: "not found" });
  if (owned.oauthStatus !== "pending") {
    throw createError({
      statusCode: 409,
      statusMessage: "credential is no longer pending — use DELETE on /api/me/llm-credentials/:id instead",
    });
  }

  try { getClaudeOAuthDriver().cancel(id); } catch { /* not in memory anymore */ }
  await deleteCredential(id);
  return { ok: true };
});
