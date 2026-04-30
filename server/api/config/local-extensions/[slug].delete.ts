import { getAppConfigModule } from "@su/app-config";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "slug path parameter required" });
  }
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
