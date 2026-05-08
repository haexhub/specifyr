import { z } from "zod";
import { createOrgWithAdmin } from "@su/org-store";
import { parseBody } from "@su/validation";

const createOrgSchema = z.object({
  name: z.string().trim().min(2).max(120),
});

export default defineEventHandler(async (event) => {
  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }

  const { name } = await parseBody(event, createOrgSchema);

  try {
    const org = await createOrgWithAdmin(name, userId);
    return org;
  } catch (err) {
    const message = err instanceof Error ? err.message : "could not create org";
    const status = /unique|duplicate/i.test(message) ? 409 : 400;
    throw createError({ statusCode: status, statusMessage: message });
  }
});
