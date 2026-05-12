import { listCredentialsFor } from "@su/llm-credentials-store";

export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }
  return listCredentialsFor("user", userId);
});
