import {
  createOAuthClaudeCredential,
  deleteCredential,
  getCredentialOwnedBy,
  listCredentialsFor,
} from "@su/llm-credentials-store";
import { ownerCredentialsHome } from "@su/data-dirs";
import { getClaudeOAuthDriver } from "@su/claude-oauth-driver";

/**
 * Starts a personal `claude auth login` OAuth flow.
 *
 * Side effects (idempotent on re-call — old pending row is replaced):
 *   1. cancel any existing pending oauth_claude credential for this user
 *   2. insert a fresh pending oauth_claude row → returns its id
 *   3. spawn `claude auth login --claudeai` with HOME pointing at the
 *      per-user credentials dir; capture the auth URL from stdout
 *   4. return { id, url } — the frontend opens the URL in a new tab
 *      and shows a code-paste field that POSTs to /code
 */
export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }

  // Sweep stale pending rows for this user — only one OAuth flow may
  // be active at a time, and the stored row is just a placeholder
  // until the spawned CLI succeeds.
  const existing = await listCredentialsFor("user", userId);
  for (const c of existing) {
    if (c.mode === "oauth_claude" && c.oauthStatus === "pending") {
      // Best-effort cancel of any in-memory subprocess for this id.
      try { getClaudeOAuthDriver().cancel(c.id); } catch { /* not active */ }
      await deleteCredential(c.id);
    }
  }

  const cred = await createOAuthClaudeCredential({
    ownerKind: "user",
    ownerId: userId,
    displayName: "Personal Claude (OAuth)",
  });

  const home = ownerCredentialsHome("user", userId);
  let url: string;
  try {
    const r = await getClaudeOAuthDriver().startLogin({ id: cred.id, home });
    url = r.url;
  } catch (err) {
    // Roll back the placeholder row so the user doesn't see a
    // permanently-pending credential they can't act on.
    await deleteCredential(cred.id).catch(() => {});
    const message = err instanceof Error ? err.message : "could not start oauth";
    throw createError({ statusCode: 500, statusMessage: message });
  }

  // Don't trust the in-memory state — re-fetch from DB so the
  // response is "what's persisted".
  const persisted = await getCredentialOwnedBy(cred.id, "user", userId);
  return {
    id: cred.id,
    url,
    persisted: persisted ? { id: persisted.id, oauthStatus: persisted.oauthStatus } : null,
  };
});
