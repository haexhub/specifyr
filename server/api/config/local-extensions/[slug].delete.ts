import { getAppConfigModule } from "@su/app-config";
import { orgSlugParam, parseParams } from "@su/validation";

export default defineEventHandler(async (event) => {
  const { slug } = parseParams(event, orgSlugParam);
  const { removeLocalExtension } = await getAppConfigModule();
  try {
    return await removeLocalExtension(slug);
  } catch (err) {
    const msg = (err as Error).message;
    throw createError({
      statusCode: msg.includes("not registered") ? 404 : 500,
      statusMessage: msg
    });
  }
});
