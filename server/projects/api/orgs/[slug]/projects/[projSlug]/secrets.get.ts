import { assertProjectExists } from "@su/specifyr-stores";
import { listOrgSecretKeys, listSecretKeys } from "@su/secrets-store";

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  await assertProjectExists(orgId, slug);
  const [keys, inheritedKeys] = await Promise.all([
    listSecretKeys(orgId, slug),
    listOrgSecretKeys(orgId),
  ]);
  return { keys, inheritedKeys };
});
