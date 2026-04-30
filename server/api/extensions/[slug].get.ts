import { getExtensionDetail } from "#su/extension-detail";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }
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
