import { listProjectMembers } from "@su/project-store";

/**
 * GET /api/orgs/:orgSlug/projects/:projSlug/members
 *
 * Lists explicit project members. Org admins are NOT included here
 * because they have implicit access via their org role — the
 * project_memberships table only contains explicit grants.
 *
 * Auth: project-access middleware already gates the URL. Any caller
 * who can read the project can read its member list.
 */
export default defineEventHandler(async (event) => {
  const projectId = event.context.projectId!;
  const members = await listProjectMembers(projectId);
  return { members };
});
