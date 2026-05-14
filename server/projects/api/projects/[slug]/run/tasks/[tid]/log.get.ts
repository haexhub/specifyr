import { getRunStoreModule } from "@su/run-manager";
import { dataDir } from "@su/data-dirs";
import { resolveProjectOrgId } from "@su/project-store";
import { parseParams, taskIdParams } from "@su/validation";

export default defineEventHandler(async (event) => {
  const { slug, tid } = parseParams(event, taskIdParams);

  // TODO(phase-3): drop DB lookup once project-access middleware sets event.context.orgId.
  const orgId = await resolveProjectOrgId(slug);
  const { RunStore } = await getRunStoreModule();
  const store = new RunStore(dataDir());
  const entries = await store.readTaskLog(orgId, slug, tid);
  return { slug, taskId: tid, entries };
});
