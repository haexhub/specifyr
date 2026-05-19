import { deleteDraft } from "@su/spec-draft-store";
import { draftId as draftIdSchema } from "@su/spec-tools-schemas";

/**
 * Discard a draft. Hard-deletes `status='draft'` rows (and cascades
 * to spec_draft_files). `status='published'` rows are immutable —
 * they are part of the audit trail — and return 409.
 *
 * Non-owners and non-existent IDs both surface as 404 so we don't
 * leak which IDs exist outside the caller's drafts.
 */
export default defineEventHandler(async (event) => {
  const userId = event.context.userId!;
  const projectId = event.context.projectId!;

  const rawId = getRouterParam(event, "draftId");
  const parsedId = draftIdSchema.safeParse(rawId);
  if (!parsedId.success) {
    throw createError({ statusCode: 400, statusMessage: "invalid draftId" });
  }

  const result = await deleteDraft(parsedId.data, projectId, userId);
  if ("error" in result) {
    if (result.error === "published_immutable") {
      throw createError({
        statusCode: 409,
        statusMessage: "published drafts are immutable",
      });
    }
    throw createError({ statusCode: 404, statusMessage: "draft not found" });
  }
  return { ok: true as const };
});
