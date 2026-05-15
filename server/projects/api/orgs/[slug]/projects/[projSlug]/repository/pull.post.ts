import { assertProjectExists } from "@su/specifyr-stores";
import { getProjectRepository } from "@su/project-repository";
import { getProjectSecrets, GIT_REMOTE_TOKEN_KEY } from "@su/secrets-store";
import { configureRemote, pullFromRemote } from "@su/git-remote";
import { projectDir } from "@su/data-dirs";

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  await assertProjectExists(orgId, slug);

  const cfg = await getProjectRepository(orgId, slug);
  if (!cfg) {
    throw createError({
      statusCode: 400,
      statusMessage: "Repository not configured.",
    });
  }
  const secrets = await getProjectSecrets(orgId, slug);
  const token = secrets[GIT_REMOTE_TOKEN_KEY];
  if (!token) {
    throw createError({
      statusCode: 400,
      statusMessage: "Repository token missing.",
    });
  }

  const projectRoot = projectDir(orgId, slug);
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
