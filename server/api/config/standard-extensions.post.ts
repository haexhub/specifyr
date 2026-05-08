import { z } from "zod";
import { getAppConfigModule } from "@su/app-config";
import { parseBody } from "@su/validation";

const bodySchema = z.object({
  extensions: z.array(z.string().trim().min(1)),
});

export default defineEventHandler(async (event) => {
  const { extensions } = await parseBody(event, bodySchema);
  const list = extensions.filter(Boolean);

  const { setStandardExtensions } = await getAppConfigModule();
  const saved = await setStandardExtensions(list);
  return { extensions: saved };
});
