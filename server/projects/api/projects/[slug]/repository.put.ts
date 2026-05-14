import { z } from "zod";
import { assertProjectExists } from "@su/specifyr-stores";
import { setProjectRepository } from "@su/project-repository";
import { setSecret, GIT_REMOTE_TOKEN_KEY } from "@su/secrets-store";
import { parseBody, parseParams, projectSlugParam } from "@su/validation";

const bodySchema = z.object({
  url: z.string().trim().min(1).max(2048),
  branch: z.string().trim().min(1).max(255).default("main"),
  username: z.string().trim().min(1).max(255),
  token: z.string().min(1).max(4096),
});

export default defineEventHandler(async (event) => {
  const { slug } = parseParams(event, projectSlugParam);
  await assertProjectExists(slug);
  const body = await parseBody(event, bodySchema);

  try {
    await setProjectRepository(slug, {
      url: body.url,
      branch: body.branch,
      username: body.username,
    });
  } catch (err) {
    throw createError({
      statusCode: 400,
      statusMessage: (err as Error).message,
    });
  }
  await setSecret(slug, GIT_REMOTE_TOKEN_KEY, body.token);
  return { ok: true };
});
