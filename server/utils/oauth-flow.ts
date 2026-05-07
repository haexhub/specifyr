/**
 * Shared orchestration for the Phase 8/9 Claude-OAuth flow. Personal
 * (`user`) and org-level (`org`) endpoints both end up calling
 * startOAuthFlowFor — the only difference is who is allowed to call
 * it (auth gate lives in the route handler).
 *
 * Lives outside of llm-credentials-store.ts because it composes a
 * store call with a subprocess spawn, which is a wider concern than
 * a store layer should own.
 */

import {
  createOAuthClaudeCredential,
  deleteCredential,
  getCredentialOwnedBy,
  listCredentialsFor,
} from "./llm-credentials-store";
import { ownerCredentialsHome } from "./data-dirs";
import { getClaudeOAuthDriver } from "./claude-oauth-driver";

export type OAuthFlowStart = {
  id: string;
  url: string;
  persisted: { id: string; oauthStatus: "pending" | "authorized" | "expired" | null } | null;
};

/**
 * Begins an OAuth flow for an arbitrary owner. Side effects:
 *   1. cancel + delete any existing pending oauth_claude row for the
 *      owner (only one in-flight flow per owner)
 *   2. insert a fresh pending row → returns its id
 *   3. spawn `claude auth login --claudeai` with HOME pointing at
 *      <credentialsDir>/<ownerKind>/<ownerId>; capture the auth URL
 *      from stdout
 *
 * Throws on spawn / URL-parse failure (caller maps to HTTP 500).
 * Side-rolls back the placeholder row when the spawn fails so the
 * UI doesn't show a permanently-pending credential.
 */
export async function startOAuthFlowFor(
  ownerKind: "user" | "org",
  ownerId: string,
  displayName: string,
): Promise<OAuthFlowStart> {
  // Sweep stale pending rows. Only one OAuth flow may be active at a
  // time per owner; the placeholder is just a UI hook until the
  // spawned CLI succeeds.
  const existing = await listCredentialsFor(ownerKind, ownerId);
  for (const c of existing) {
    if (c.mode === "oauth_claude" && c.oauthStatus === "pending") {
      try {
        getClaudeOAuthDriver().cancel(c.id);
      } catch {
        /* not in memory */
      }
      await deleteCredential(c.id);
    }
  }

  const cred = await createOAuthClaudeCredential({
    ownerKind,
    ownerId,
    displayName,
  });

  const home = ownerCredentialsHome(ownerKind, ownerId);
  let url: string;
  try {
    const r = await getClaudeOAuthDriver().startLogin({ id: cred.id, home });
    url = r.url;
  } catch (err) {
    await deleteCredential(cred.id).catch(() => {});
    throw err;
  }

  const persisted = await getCredentialOwnedBy(cred.id, ownerKind, ownerId);
  return {
    id: cred.id,
    url,
    persisted: persisted
      ? { id: persisted.id, oauthStatus: persisted.oauthStatus }
      : null,
  };
}
