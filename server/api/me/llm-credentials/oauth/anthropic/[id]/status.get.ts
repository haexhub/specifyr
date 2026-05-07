import {
  getCredentialOwnedBy,
  markOAuthAuthorized,
} from "@su/llm-credentials-store";
import { ownerCredentialsHome } from "@su/data-dirs";
import { readCredentialsExpiry } from "@su/claude-oauth-driver";

/**
 * Polled by the frontend every ~2s while a flow is open. Doesn't
 * touch the spawned subprocess — it only reads the on-disk
 * credentials file. Useful as a fallback in case the user closed the
 * page mid-flow and reopened it: the next poll will see the file and
 * mark the row authorized.
 */
export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "id required" });

  const owned = await getCredentialOwnedBy(id, "user", userId);
  if (!owned) throw createError({ statusCode: 404, statusMessage: "not found" });

  const home = ownerCredentialsHome("user", userId);
  const expiresAt = await readCredentialsExpiry(home);

  if (expiresAt && owned.oauthStatus !== "authorized") {
    await markOAuthAuthorized(id, new Date());
  }

  return {
    id,
    oauthStatus: expiresAt ? "authorized" : owned.oauthStatus,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };
});
