import { listProjectWorkflows } from "#su/workflow-discovery";
import { assertProjectExists } from "#su/specops-stores";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }
  await assertProjectExists(slug);
  return await listProjectWorkflows(slug);
});
