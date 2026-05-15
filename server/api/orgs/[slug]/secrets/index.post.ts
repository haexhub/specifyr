import { z } from "zod";
import { setOrgSecret } from "@su/secrets-store";
import { requireOrgAdmin } from "@su/org-auth";
import { parseBody } from "@su/validation";

// POSIX env-var name shape: leading letter or underscore, then letters,
// digits, underscores. The UI uppercases via sanitizeKey() before
// submit; the server enforces it independently so a hand-rolled curl
// can't smuggle in shell-hostile characters that would later end up in
// `env[KEY]` of an agent container.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const secretSchema = z.object({
  key: z.string().trim().min(1).max(256).regex(ENV_NAME_RE, "Invalid env-var name"),
  value: z.string().min(1),
});

export default defineEventHandler(async (event) => {
  const { org } = await requireOrgAdmin(event);
  const { key, value } = await parseBody(event, secretSchema);
  await setOrgSecret(org.id, key, value);
  return { ok: true, key };
});
