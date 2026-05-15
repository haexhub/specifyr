import { z } from "zod";
import { assertProjectExists } from "@su/specifyr-stores";
import { setSecret } from "@su/secrets-store";
import { parseBody } from "@su/validation";

const secretSchema = z.object({
  key: z.string().trim().min(1).max(256),
  value: z.string().min(1),
});

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  await assertProjectExists(orgId, slug);

  const { key, value } = await parseBody(event, secretSchema);

  await setSecret(orgId, slug, key, value);
  return { ok: true, key };
});
