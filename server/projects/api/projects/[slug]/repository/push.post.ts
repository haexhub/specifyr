import { z } from "zod";
import path from "node:path";
import { assertProjectExists } from "@su/specifyr-stores";
import { getProjectRepository } from "@su/project-repository";
import { getProjectSecrets, GIT_REMOTE_TOKEN_KEY } from "@su/secrets-store";
import { configureRemote, commitAndPush } from "@su/git-remote";
import { projectsDir } from "@su/data-dirs";
import { parseBody, parseParams, projectSlugParam } from "@su/validation";

const bodySchema = z.object({
  message: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .default("specifyr: workflow progress"),
});

export default defineEventHandler(async (event) => {
  const { slug } = parseParams(event, projectSlugParam);
  await assertProjectExists(slug);
  const { message } = await parseBody(event, bodySchema);

  const cfg = await getProjectRepository(slug);
  if (!cfg) {
    throw createError({
      statusCode: 400,
      statusMessage: "Repository not configured.",
    });
  }
  const secrets = await getProjectSecrets(slug);
  const token = secrets[GIT_REMOTE_TOKEN_KEY];
  if (!token) {
    throw createError({
      statusCode: 400,
      statusMessage: "Repository token missing.",
    });
  }

  const projectRoot = path.join(projectsDir(), slug);
  try {
    await configureRemote(projectRoot, cfg.url);
  } catch (err) {
    throw createError({
      statusCode: 400,
      statusMessage: (err as Error).message,
    });
  }
  const result = await commitAndPush({
    projectRoot,
    branch: cfg.branch,
    message,
    bearerToken: token,
  });
  if (!result.ok) {
    throw createError({
      statusCode: 502,
      statusMessage: result.stderr || "push failed",
    });
  }
  return { ok: true, pushed: result.pushed };
});
