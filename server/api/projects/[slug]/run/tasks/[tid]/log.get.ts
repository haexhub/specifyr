import { getRunStoreModule } from "#su/run-manager";
import { dataDir } from "#su/data-dirs";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  const tid = getRouterParam(event, "tid");
  if (!slug || !tid) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug/tid" });
  }

  const { RunStore } = await getRunStoreModule();
  const store = new RunStore(dataDir());
  const entries = await store.readTaskLog(slug, tid);
  return { slug, taskId: tid, entries };
});
