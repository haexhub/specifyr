import path from "node:path";
import { assertProjectExists } from "@su/specifyr-stores";
import { getProjectRepository } from "@su/project-repository";
import { getProjectSecrets, GIT_REMOTE_TOKEN_KEY } from "@su/secrets-store";
import { configureRemote, pullFromRemote } from "@su/git-remote";
import { projectsDir } from "@su/data-dirs";
import { parseParams, projectSlugParam } from "@su/validation";

export default defineEventHandler(async (event) => {
  const { slug } = parseParams(event, projectSlugParam);
  await assertProjectExists(slug);

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
  const result = await pullFromRemote({
    projectRoot,
    branch: cfg.branch,
    bearerToken: token,
  });
  if (!result.ok) {
    throw createError({
      statusCode: 409,
      statusMessage: result.stderr || "pull failed",
    });
  }
  return { ok: true, updated: result.updated };
});
