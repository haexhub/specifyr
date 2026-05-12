import { getCredentialOwnedBy } from "@su/llm-credentials-store";
import { idUuidParam, parseParams } from "@su/validation";

/**
 * Polled by the frontend every ~2s while a flow is open AND on the
 * settings page when reviewing connected credentials.
 *
 * Source of truth ist jetzt die DB-Row: das tmp-HOME existiert nur
 * während des aktiven OAuth-Flows (zwischen startLogin und submitCode)
 * und wird danach gelöscht. Status wird aus oauthStatus + dem
 * Vorhandensein von oauthCredentialsData abgeleitet:
 *   - row.oauthCredentialsData NULL          → pending (flow läuft noch)
 *   - row.oauthCredentialsData gesetzt       → authorized
 *   - row.oauthExpiresAt in der Vergangenheit → expired (proxy refresht
 *     beim nächsten Spawn — falls das fehlschlägt, schreibt der proxy
 *     den Row zurück auf NULL → "expired" stays bis re-auth).
 *
 * `fileExists` bleibt für UI-Kompatibilität, mappt jetzt auf "DB hat
 * den verschlüsselten Blob".
 */
export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }
  const { id } = parseParams(event, idUuidParam);

  const owned = await getCredentialOwnedBy(id, "user", userId);
  if (!owned) throw createError({ statusCode: 404, statusMessage: "not found" });

  const hasBlob = !!owned.oauthCredentialsData;
  const expiresAt = owned.oauthExpiresAt;

  return {
    id,
    oauthStatus: owned.oauthStatus,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    fileExists: hasBlob,
  };
});
