import { z } from "zod";
import { assertProjectExists } from "@su/specifyr-stores";
import { setSecret, GIT_REMOTE_TOKEN_KEY } from "@su/secrets-store";
import { parseBody } from "@su/validation";

// POSIX env-var name shape: leading letter or underscore, then letters,
// digits, underscores. Mirrors the org-level endpoint's validation; the
// UI's sanitizeKey() already uppercases input so the server check only
// trips on hand-rolled clients.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const secretSchema = z.object({
  key: z.string().trim().min(1).max(256).regex(ENV_NAME_RE, "Invalid env-var name"),
  value: z.string().min(1),
});

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  await assertProjectExists(orgId, slug);

  const { key, value } = await parseBody(event, secretSchema);

  if (key === GIT_REMOTE_TOKEN_KEY) {
    throw createError({
      statusCode: 400,
      statusMessage:
        "Reserved key — use /api/orgs/:orgSlug/projects/:projSlug/repository to manage the git remote token.",
    });
  }

  await setSecret(orgId, slug, key, value);
  return { ok: true, key };
});
