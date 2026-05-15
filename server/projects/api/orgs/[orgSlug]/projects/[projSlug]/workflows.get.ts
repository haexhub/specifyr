import { listProjectWorkflows } from "@su/workflow-discovery";
import { assertProjectExists } from "@su/specifyr-stores";

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  await assertProjectExists(orgId, slug);
  return await listProjectWorkflows(orgId, slug);
});
