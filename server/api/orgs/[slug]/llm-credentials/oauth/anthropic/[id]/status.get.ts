import { getCredentialOwnedBy } from "@su/llm-credentials-store";
import { requireOrgMembership } from "@su/org-auth";
import { orgCredentialParams, parseParams } from "@su/validation";

/**
 * Polled status endpoint — readable by any member so non-admins can
 * see "is the org logged in?" without being able to mutate the flow.
 *
 * DB is source of truth (siehe Kommentar in der user-personal Variante).
 */
export default defineEventHandler(async (event) => {
  const { org } = await requireOrgMembership(event);
  const { id } = parseParams(event, orgCredentialParams);

  const owned = await getCredentialOwnedBy(id, "org", org.id);
  if (!owned) throw createError({ statusCode: 404, statusMessage: "not found" });

  const hasBlob = !!owned.oauthCredentialsData;
  const expiresAt = owned.oauthExpiresAt;
  const oauthStatus =
    owned.oauthStatus === "authorized" &&
    expiresAt &&
    expiresAt.getTime() < Date.now()
      ? "expired"
      : owned.oauthStatus;

  return {
    id,
    oauthStatus,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    fileExists: hasBlob,
  };
});
