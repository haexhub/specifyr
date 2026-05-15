import { assertProjectExists } from "@su/specifyr-stores";
import { listSecretKeys } from "@su/secrets-store";

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  await assertProjectExists(orgId, slug);
  return { keys: await listSecretKeys(orgId, slug) };
});
