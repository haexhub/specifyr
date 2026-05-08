import { acceptInvite } from "@su/org-store";
import { parseParams, tokenParam } from "@su/validation";

export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }

  const { token } = parseParams(event, tokenParam);

  const result = await acceptInvite(token, userId);
  if (!result.ok) {
    const status =
      result.reason === "not_found"
        ? 404
        : result.reason === "expired"
          ? 410
          : 409;
    throw createError({ statusCode: status, statusMessage: result.reason });
  }
  return { orgSlug: result.orgSlug, role: result.role };
});
