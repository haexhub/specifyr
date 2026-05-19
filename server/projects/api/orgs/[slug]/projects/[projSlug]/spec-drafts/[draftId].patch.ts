import { patchDraft } from "@su/spec-draft-store";
import {
  draftId as draftIdSchema,
  patchDraftBody,
} from "#shared/utils/spec-tools-schemas";
import { parseBody } from "@su/validation";

/**
 * Partial update of a draft — "Save to Server" from the browser agent.
 *
 * Only the owner of a `status='draft'` row can patch. Published rows
 * are immutable (the audit trail). The store enforces both conditions
 * in the UPDATE's WHERE clause and returns `not_found` for any miss,
 * which we surface as 404 — we do not distinguish between "doesn't
 * exist", "not yours", or "published" here, so attackers can't probe
 * for draft IDs they don't own.
 *
 * The Zod body schema rejects empty patches (at least one of title /
 * files / conversation must be present) so a no-op PATCH doesn't slip
 * through and bump updated_at without intent.
 */
export default defineEventHandler(async (event) => {
  const userId = event.context.userId!;
  const projectId = event.context.projectId!;

  const rawId = getRouterParam(event, "draftId");
  const parsedId = draftIdSchema.safeParse(rawId);
  if (!parsedId.success) {
    throw createError({ statusCode: 400, statusMessage: "invalid draftId" });
  }
  const body = await parseBody(event, patchDraftBody);

  const result = await patchDraft(parsedId.data, projectId, userId, body);
  if ("error" in result) {
    throw createError({ statusCode: 404, statusMessage: "draft not found" });
  }
  return { updatedAt: result.updatedAt.toISOString() };
});
