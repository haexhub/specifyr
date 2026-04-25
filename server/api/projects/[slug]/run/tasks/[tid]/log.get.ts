import { getRunStoreModule } from "../../../../../../utils/run-manager";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  const tid = getRouterParam(event, "tid");
  if (!slug || !tid) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug/tid" });
  }

  const { RunStore } = await getRunStoreModule();
  const store = new RunStore(process.cwd());
  const entries = await store.readTaskLog(slug, tid);
  return { slug, taskId: tid, entries };
});
