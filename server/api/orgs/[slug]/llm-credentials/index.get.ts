import { listCredentialsFor } from "@su/llm-credentials-store";
import { requireOrgMembership } from "@su/org-auth";

export default defineEventHandler(async (event) => {
  const { org, membership } = await requireOrgMembership(event);
  const credentials = await listCredentialsFor("org", org.id);
  return {
    org: { id: org.id, slug: org.slug, name: org.name },
    myRole: membership.role,
    credentials,
  };
});
