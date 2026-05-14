import { assertProjectExists } from "@su/specifyr-stores";
import { getProjectRepository } from "@su/project-repository";
import { getProjectSecrets, GIT_REMOTE_TOKEN_KEY } from "@su/secrets-store";
import { parseParams, projectSlugParam } from "@su/validation";

export default defineEventHandler(async (event) => {
  const { slug } = parseParams(event, projectSlugParam);
  await assertProjectExists(slug);
  const cfg = await getProjectRepository(slug);
  if (!cfg) return { configured: false };
  const secrets = await getProjectSecrets(slug);
  return {
    configured: true,
    url: cfg.url,
    branch: cfg.branch,
    username: cfg.username,
    lastPushedAt: cfg.lastPushedAt ?? null,
    hasToken: !!secrets[GIT_REMOTE_TOKEN_KEY],
  };
});
