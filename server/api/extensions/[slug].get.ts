import { getExtensionDetail } from "@su/extension-detail";
import { orgSlugParam, parseParams } from "@su/validation";

export default defineEventHandler(async (event) => {
  const { slug } = parseParams(event, orgSlugParam);
  try {
    return await getExtensionDetail(slug);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Detail unavailable";
    throw createError({
      statusCode: message.includes("not found") ? 404 : 503,
      statusMessage: message
    });
  }
});
