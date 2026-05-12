import { z } from "zod";
import { assertProjectExists } from "@su/specifyr-stores";
import { setSecret } from "@su/secrets-store";
import { parseBody, parseParams, projectSlugParam } from "@su/validation";

const secretSchema = z.object({
  key: z.string().trim().min(1).max(256),
  value: z.string().min(1),
});

export default defineEventHandler(async (event) => {
  const { slug } = parseParams(event, projectSlugParam);
  await assertProjectExists(slug);

  const { key, value } = await parseBody(event, secretSchema);

  await setSecret(slug, key, value);
  return { ok: true, key };
});
