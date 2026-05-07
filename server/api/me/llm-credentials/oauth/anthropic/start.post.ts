import { startOAuthFlowFor } from "@su/oauth-flow";

/**
 * Starts a personal `claude auth login` OAuth flow. Wraps the
 * shared startOAuthFlowFor with this user's identity — the org-level
 * variant is at /api/orgs/:slug/llm-credentials/oauth/anthropic/start.
 */
export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }
  try {
    return await startOAuthFlowFor("user", userId, "Personal Claude (OAuth)");
  } catch (err) {
    const message = err instanceof Error ? err.message : "could not start oauth";
    throw createError({ statusCode: 500, statusMessage: message });
  }
});
