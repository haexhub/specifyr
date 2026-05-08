import {
  getCredentialOwnedBy,
  markOAuthAuthorized,
  markOAuthExpired,
} from "@su/llm-credentials-store";
import { ownerCredentialsHome } from "@su/data-dirs";
import { readCredentialsState } from "@su/claude-oauth-driver";

/**
 * Polled by the frontend every ~2s while a flow is open AND on the
 * settings page when reviewing connected credentials. The on-disk
 * `.credentials.json` is the source of truth — the DB row is a cache
 * that can drift (e.g. user wiped the dir, CLI refreshed the token).
 *
 * Drift handling:
 *   - file present + DB pending → mark authorized
 *   - file missing + DB authorized → mark expired
 *
 * Returned `fileExists` lets the UI distinguish "expired but file
 * present (CLI will refresh)" from "missing (re-auth required)".
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
