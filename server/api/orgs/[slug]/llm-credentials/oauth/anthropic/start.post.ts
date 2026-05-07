import { requireOrgAdmin } from "@su/org-auth";
import { startOAuthFlowFor } from "@su/oauth-flow";

/**
 * Org-level `claude auth login` flow — admin-only. Same shape as
 * /api/me/llm-credentials/oauth/anthropic/start but the OAuth tokens
 * land under <credentialsDir>/org/<orgId>/.claude/ so any member of
 * the org can resolve through them.
 */
export default defineEventHandler(async (event) => {
  const { org } = await requireOrgAdmin(event);
  try {
    return await startOAuthFlowFor("org", org.id, `${org.name} Claude (OAuth)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "could not start oauth";
    throw createError({ statusCode: 500, statusMessage: message });
  }
});
