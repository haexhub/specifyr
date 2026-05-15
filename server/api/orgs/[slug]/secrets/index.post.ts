import { z } from "zod";
import { setOrgSecret } from "@su/secrets-store";
import { requireOrgAdmin } from "@su/org-auth";
import { parseBody } from "@su/validation";

const secretSchema = z.object({
  key: z.string().trim().min(1).max(256),
  value: z.string().min(1),
});

export default defineEventHandler(async (event) => {
  const { org } = await requireOrgAdmin(event);
  const { key, value } = await parseBody(event, secretSchema);
  await setOrgSecret(org.id, key, value);
  return { ok: true, key };
});
