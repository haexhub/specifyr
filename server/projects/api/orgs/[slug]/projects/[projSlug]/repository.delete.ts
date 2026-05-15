import { assertProjectExists } from "@su/specifyr-stores";
import { clearProjectRepository } from "@su/project-repository";
import { deleteSecret, GIT_REMOTE_TOKEN_KEY } from "@su/secrets-store";

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  await assertProjectExists(orgId, slug);
  await clearProjectRepository(orgId, slug);
  await deleteSecret(orgId, slug, GIT_REMOTE_TOKEN_KEY);
  return { ok: true };
});
