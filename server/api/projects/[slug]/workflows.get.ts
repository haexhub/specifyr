import { listProjectWorkflows } from "../../../utils/workflow-discovery";
import { assertProjectExists } from "../../../utils/specops-stores";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }
  await assertProjectExists(slug);
  return await listProjectWorkflows(slug);
});
