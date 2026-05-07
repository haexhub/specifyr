import {
  getCredentialOwnedBy,
  markOAuthAuthorized,
} from "@su/llm-credentials-store";
import { ownerCredentialsHome } from "@su/data-dirs";
import {
  getClaudeOAuthDriver,
  readCredentialsExpiry,
} from "@su/claude-oauth-driver";
import { requireOrgAdmin } from "@su/org-auth";

/**
 * Pipes the user-pasted OAuth code into the held-open subprocess
 * for an org-level flow. Admin-only — only the user who started the
 * flow (an admin) is expected to hold the code, but any admin may
 * complete a flow they didn't start.
 */
export default defineEventHandler(async (event) => {
  const { org } = await requireOrgAdmin(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "id required" });

  const owned = await getCredentialOwnedBy(id, "org", org.id);
  if (!owned) throw createError({ statusCode: 404, statusMessage: "not found" });

  const body = await readBody<{ code?: string }>(event);
  const code = body?.code?.trim() ?? "";
  if (code.length < 4) {
    throw createError({ statusCode: 400, statusMessage: "code required" });
  }

  try {
    await getClaudeOAuthDriver().submitCode(id, code);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "code submission failed";
    throw createError({ statusCode: 400, statusMessage: message });
  }

  const home = ownerCredentialsHome("org", org.id);
  const expiresAt = await readCredentialsExpiry(home);
  if (!expiresAt) {
    throw createError({
      statusCode: 500,
      statusMessage: "credentials.json was not written by the CLI",
    });
  }

  const updated = await markOAuthAuthorized(id, new Date());
  return {
    id,
    oauthStatus: updated?.oauthStatus ?? "authorized",
    expiresAt: expiresAt.toISOString(),
  };
});
