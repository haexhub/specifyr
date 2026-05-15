import { assertProjectExists } from "@su/specifyr-stores";
import { getProjectRepository } from "@su/project-repository";
import { getProjectSecrets, GIT_REMOTE_TOKEN_KEY } from "@su/secrets-store";

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  await assertProjectExists(orgId, slug);
  const cfg = await getProjectRepository(orgId, slug);
  if (!cfg) return { configured: false };
  const secrets = await getProjectSecrets(orgId, slug);
  return {
    configured: true,
    url: cfg.url,
    branch: cfg.branch,
    username: cfg.username,
    lastPushedAt: cfg.lastPushedAt ?? null,
    hasToken: !!secrets[GIT_REMOTE_TOKEN_KEY],
  };
});
