import {
  getCredentialOwnedBy,
  markOAuthAuthorized,
} from "@su/llm-credentials-store";
import { oauthTempHome, removeOauthTempHome } from "@su/data-dirs";
import {
  getClaudeOAuthDriver,
  readCredentialsRawAndExpiry,
} from "@su/claude-oauth-driver";
import {
  idUuidParam,
  oauthCodeSchema,
  parseBody,
  parseParams,
} from "@su/validation";

/**
 * Submits the user-pasted OAuth code to the held-open
 * `claude auth login` subprocess. Pipes the code into stdin, awaits
 * the CLI exit, then verifies `.credentials.json` is on disk and
 * stamps the DB row authorized.
 *
 * Returns the parsed expiry so the frontend can show "logged in
 * until X" without a follow-up status poll.
 */
export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }
  const { id } = parseParams(event, idUuidParam);

  // Ownership gate before touching the driver — a stranger's id
  // can't manipulate someone else's flow.
  const owned = await getCredentialOwnedBy(id, "user", userId);
  if (!owned) throw createError({ statusCode: 404, statusMessage: "not found" });

  const { code } = await parseBody(event, oauthCodeSchema);

  try {
    await getClaudeOAuthDriver().submitCode(id, code);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "code submission failed";
    throw createError({ statusCode: 400, statusMessage: message });
  }

  // finally guarantees tmp-HOME cleanup even if readCredentialsRawAndExpiry
  // or markOAuthAuthorized throws — otherwise plaintext credentials.json
  // would linger in /tmp.
  const home = oauthTempHome(id);
  try {
    const payload = await readCredentialsRawAndExpiry(home);
    if (!payload) {
      throw createError({
        statusCode: 500,
        statusMessage: "credentials.json was not written by the CLI",
      });
    }

    const updated = await markOAuthAuthorized(id, new Date(), payload);

    return {
      id,
      oauthStatus: updated?.oauthStatus ?? "authorized",
      expiresAt: payload.expiresAt ? payload.expiresAt.toISOString() : null,
    };
  } finally {
    await removeOauthTempHome(id).catch(() => {});
  }
});
