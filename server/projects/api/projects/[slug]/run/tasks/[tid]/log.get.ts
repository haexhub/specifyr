import { getRunStoreModule } from "@su/run-manager";
import { dataDir } from "@su/data-dirs";
import { parseParams, taskIdParams } from "@su/validation";

export default defineEventHandler(async (event) => {
  const { slug, tid } = parseParams(event, taskIdParams);

  const { RunStore } = await getRunStoreModule();
  const store = new RunStore(dataDir());
  const entries = await store.readTaskLog(slug, tid);
  return { slug, taskId: tid, entries };
});
