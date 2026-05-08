import {
  getCredentialOwnedBy,
  markOAuthAuthorized,
  markOAuthExpired,
} from "@su/llm-credentials-store";
import { ownerCredentialsHome } from "@su/data-dirs";
import { readCredentialsState } from "@su/claude-oauth-driver";
import { requireOrgMembership } from "@su/org-auth";

/**
 * Polled status endpoint — readable by any member so non-admins can
 * see "is the org logged in?" without being able to mutate the flow.
 *
 * Drift handling mirrors the user-personal endpoint: the on-disk
 * `.credentials.json` is the source of truth; the DB row is a cache.
 */
export default defineEventHandler(async (event) => {
  const { org } = await requireOrgMembership(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "id required" });

  const owned = await getCredentialOwnedBy(id, "org", org.id);
  if (!owned) throw createError({ statusCode: 404, statusMessage: "not found" });

  const home = ownerCredentialsHome("org", org.id);
  const disk = await readCredentialsState(home);
  const fileExists = disk.kind === "present";
  const expiresAt = disk.kind === "present" ? disk.expiresAt : null;

  let oauthStatus = owned.oauthStatus;
  if (fileExists && oauthStatus !== "authorized") {
    await markOAuthAuthorized(id, new Date());
    oauthStatus = "authorized";
  } else if (!fileExists && oauthStatus === "authorized") {
    await markOAuthExpired(id);
    oauthStatus = "expired";
  }

  return {
    id,
    oauthStatus,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    fileExists,
  };
});
