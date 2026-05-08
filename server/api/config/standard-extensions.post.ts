import { z } from "zod";
import { getAppConfigModule } from "@su/app-config";
import { parseBody } from "@su/validation";
import { requirePlatformAdmin } from "@su/platform-admin-auth";

const bodySchema = z.object({
  extensions: z.array(z.string().trim().min(1)),
});

// `standardExtensions` is the auto-install list applied to every new
// project on the deployment, so changing it has cross-org effect —
// platform-admin-only.
export default defineEventHandler(async (event) => {
  await requirePlatformAdmin(event);
  const { extensions } = await parseBody(event, bodySchema);
  const list = extensions.filter(Boolean);

  const { setStandardExtensions } = await getAppConfigModule();
  const saved = await setStandardExtensions(list);
  return { extensions: saved };
});
