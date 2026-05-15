import { z } from "zod";
import { removeProjectMember } from "@su/project-store";
import { parseParams } from "@su/validation";

const params = z.object({
  userId: z.uuid(),
});

/**
 * DELETE /api/orgs/:orgSlug/projects/:projSlug/members/:userId
 *
 * Revokes explicit project access. Doesn't affect org-admin access —
 * admins have implicit access not stored here.
 *
 * Authorization: org admins only.
 */
export default defineEventHandler(async (event) => {
  const orgRole = event.context.orgRole;
  if (orgRole !== "admin") {
    throw createError({
      statusCode: 403,
      statusMessage: "Only org admins can manage project members.",
    });
  }
  const projectId = event.context.projectId!;
  const { userId } = parseParams(event, params);

  const removed = await removeProjectMember(projectId, userId);
  if (!removed) {
    throw createError({
      statusCode: 404,
      statusMessage: "Not a project member",
    });
  }
  setResponseStatus(event, 204);
  return null;
});
