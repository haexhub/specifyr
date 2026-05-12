import {
  getCredentialOwnedBy,
  markOAuthAuthorized,
} from "@su/llm-credentials-store";
import { oauthTempHome, removeOauthTempHome } from "@su/data-dirs";
import {
  getClaudeOAuthDriver,
  readCredentialsRawAndExpiry,
} from "@su/claude-oauth-driver";
import { requireOrgAdmin } from "@su/org-auth";
import {
  oauthCodeSchema,
  orgCredentialParams,
  parseBody,
  parseParams,
} from "@su/validation";

/**
 * Pipes the user-pasted OAuth code into the held-open subprocess
 * for an org-level flow. Admin-only — only the user who started the
 * flow (an admin) is expected to hold the code, but any admin may
 * complete a flow they didn't start.
 */
export default defineEventHandler(async (event) => {
  const { org } = await requireOrgAdmin(event);
  const { id } = parseParams(event, orgCredentialParams);

  const owned = await getCredentialOwnedBy(id, "org", org.id);
  if (!owned) throw createError({ statusCode: 404, statusMessage: "not found" });

  const { code } = await parseBody(event, oauthCodeSchema);

  try {
    await getClaudeOAuthDriver().submitCode(id, code);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "code submission failed";
    throw createError({ statusCode: 400, statusMessage: message });
  }

  // CLI hat die credentials.json im tmp-HOME geschrieben. Einmal auslesen,
  // verschlüsselt in DB persistieren, dann tmp-HOME wegräumen.
  // finally garantiert, dass das tmp-HOME auch bei Fehlern in
  // readCredentialsRawAndExpiry/markOAuthAuthorized abgeräumt wird —
  // sonst bleibt plaintext credentials.json in /tmp liegen.
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
