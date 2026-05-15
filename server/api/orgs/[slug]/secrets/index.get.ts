import { listOrgSecretKeys } from "@su/secrets-store";
import { requireOrgMembership } from "@su/org-auth";

export default defineEventHandler(async (event) => {
  const { org, membership } = await requireOrgMembership(event);
  return {
    org: { id: org.id, slug: org.slug, name: org.name },
    myRole: membership.role,
    keys: await listOrgSecretKeys(org.id),
  };
});
