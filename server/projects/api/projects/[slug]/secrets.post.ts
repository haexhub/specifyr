import { z } from "zod";
import { assertProjectExists } from "@su/specifyr-stores";
import { setSecret, GIT_REMOTE_TOKEN_KEY } from "@su/secrets-store";
import { parseBody, parseParams, projectSlugParam } from "@su/validation";

const secretSchema = z.object({
  key: z.string().trim().min(1).max(256),
  value: z.string().min(1),
});

export default defineEventHandler(async (event) => {
  const { slug } = parseParams(event, projectSlugParam);
  await assertProjectExists(slug);

  const { key, value } = await parseBody(event, secretSchema);

  if (key === GIT_REMOTE_TOKEN_KEY) {
    throw createError({
      statusCode: 400,
      statusMessage:
        "Reserved key — use /api/projects/:slug/repository to manage the git remote token.",
    });
  }

  await setSecret(slug, key, value);
  return { ok: true, key };
});
