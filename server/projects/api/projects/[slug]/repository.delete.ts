import { assertProjectExists } from "@su/specifyr-stores";
import { clearProjectRepository } from "@su/project-repository";
import { deleteSecret, GIT_REMOTE_TOKEN_KEY } from "@su/secrets-store";
import { parseParams, projectSlugParam } from "@su/validation";

export default defineEventHandler(async (event) => {
  const { slug } = parseParams(event, projectSlugParam);
  await assertProjectExists(slug);
  await clearProjectRepository(slug);
  await deleteSecret(slug, GIT_REMOTE_TOKEN_KEY);
  return { ok: true };
});
