import { listProjectWorkflows } from "@su/workflow-discovery";
import { assertProjectExists } from "@su/specifyr-stores";
import { resolveProjectOrgId } from "@su/project-store";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }
  // TODO(phase-3): drop DB lookup once project-access middleware sets event.context.orgId.
  const orgId = await resolveProjectOrgId(slug);
  await assertProjectExists(orgId, slug);
  return await listProjectWorkflows(orgId, slug);
});
