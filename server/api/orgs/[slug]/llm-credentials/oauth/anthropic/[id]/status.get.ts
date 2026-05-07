import {
  getCredentialOwnedBy,
  markOAuthAuthorized,
} from "@su/llm-credentials-store";
import { ownerCredentialsHome } from "@su/data-dirs";
import { readCredentialsExpiry } from "@su/claude-oauth-driver";
import { requireOrgMembership } from "@su/org-auth";

/**
 * Polled status endpoint — readable by any member so non-admins can
 * see "is the org logged in?" without being able to mutate the flow.
 */
export default defineEventHandler(async (event) => {
  const { org } = await requireOrgMembership(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "id required" });

  const owned = await getCredentialOwnedBy(id, "org", org.id);
  if (!owned) throw createError({ statusCode: 404, statusMessage: "not found" });

  const home = ownerCredentialsHome("org", org.id);
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
