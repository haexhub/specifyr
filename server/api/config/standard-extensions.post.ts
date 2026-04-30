import { getAppConfigModule } from "@su/app-config";

export default defineEventHandler(async (event) => {
  const body = await readBody<{ extensions?: unknown }>(event);
  const list = Array.isArray(body?.extensions)
    ? body.extensions.map((x) => String(x).trim()).filter(Boolean)
    : null;

  if (!list) {
    throw createError({ statusCode: 400, statusMessage: "Body must contain { extensions: string[] }" });
  }

  const { setStandardExtensions } = await getAppConfigModule();
  const saved = await setStandardExtensions(list);
  return { extensions: saved };
});
