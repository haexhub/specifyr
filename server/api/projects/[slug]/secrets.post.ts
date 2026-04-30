import { assertProjectExists } from "@su/specops-stores";
import { setSecret } from "@su/secrets-store";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  await assertProjectExists(slug);

  const body = await readBody<{ key?: string; value?: string }>(event);
  if (!body?.key || typeof body.key !== "string" || !body.value || typeof body.value !== "string") {
    throw createError({ statusCode: 400, statusMessage: "Body must have { key: string, value: string }" });
  }

  await setSecret(slug, body.key.trim(), body.value);
  return { ok: true, key: body.key.trim() };
});
