import { assertProjectExists } from "@su/specifyr-stores";
import { listSecretKeys } from "@su/secrets-store";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  await assertProjectExists(slug);
  return { keys: await listSecretKeys(slug) };
});
