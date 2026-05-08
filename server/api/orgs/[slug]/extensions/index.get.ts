import { requireOrgMembership } from "@su/org-auth";
import { listOrgExtensions } from "@su/org-extensions-store";

/**
 * List all extensions registered for this org. Visible to any member.
 * Admin / `manage_extensions`-grant required for write endpoints.
 */
export default defineEventHandler(async (event) => {
  const { org } = await requireOrgMembership(event);
  const extensions = await listOrgExtensions(org.id);
  return { extensions };
});
