import { getExtensionCatalog, getLastCatalogMeta } from "../../utils/extension-catalog";

export default defineEventHandler(async (event) => {
  const q = getQuery(event);
  const force = q.refresh === "1" || q.refresh === "true";
  try {
    const extensions = await getExtensionCatalog({ force });
    return {
      meta: getLastCatalogMeta(),
      extensions
    };
  } catch (err) {
    throw createError({
      statusCode: 503,
      statusMessage: err instanceof Error ? err.message : "Catalog unavailable"
    });
  }
});
