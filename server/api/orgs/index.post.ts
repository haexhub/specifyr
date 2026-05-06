import { createOrgWithAdmin } from "@su/org-store";

export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }

  const body = await readBody<{ name?: string }>(event);
  const name = body?.name?.trim() ?? "";
  if (name.length < 2) {
    throw createError({ statusCode: 400, statusMessage: "name must be at least 2 chars" });
  }

  try {
    const org = await createOrgWithAdmin(name, userId);
    return org;
  } catch (err) {
    const message = err instanceof Error ? err.message : "could not create org";
    const status = /unique|duplicate/i.test(message) ? 409 : 400;
    throw createError({ statusCode: status, statusMessage: message });
  }
});
