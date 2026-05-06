import { listOrgsForUser } from "@su/org-store";

export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }
  return listOrgsForUser(userId);
});
