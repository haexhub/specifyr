import { z } from "zod";
import { assertProjectExists } from "@su/specifyr-stores";
import { setProjectRepository } from "@su/project-repository";
import {
  setSecret,
  listSecretKeys,
  GIT_REMOTE_TOKEN_KEY,
} from "@su/secrets-store";
import { assertRemoteSafe } from "@su/git-clone";
import { parseBody, parseParams, projectSlugParam } from "@su/validation";

const bodySchema = z.object({
  url: z.string().trim().min(1).max(2048),
  branch: z.string().trim().min(1).max(255).default("main"),
  username: z.string().trim().min(1).max(255),
  token: z.string().min(1).max(4096).optional(),
});

export default defineEventHandler(async (event) => {
  const { slug } = parseParams(event, projectSlugParam);
  await assertProjectExists(slug);
  const body = await parseBody(event, bodySchema);

  // If no token is supplied, require an existing stored token so the
  // user can update url/branch/username without re-entering credentials.
  if (!body.token) {
    const keys = await listSecretKeys(slug);
    if (!keys.includes(GIT_REMOTE_TOKEN_KEY)) {
      throw createError({
        statusCode: 400,
        statusMessage: "token is required",
      });
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(body.url);
  } catch {
    throw createError({
      statusCode: 400,
      statusMessage: "only https:// remote URLs are supported",
    });
  }
  try {
    await assertRemoteSafe(parsed);
  } catch (err) {
    throw createError({
      statusCode: 400,
      statusMessage: (err as Error).message,
    });
  }

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
  if (body.token) {
    await setSecret(slug, GIT_REMOTE_TOKEN_KEY, body.token);
  }
  return { ok: true };
});
