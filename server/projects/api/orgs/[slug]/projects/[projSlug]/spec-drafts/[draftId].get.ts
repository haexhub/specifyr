import { getDraftWithFiles } from "@su/spec-draft-store";
import { draftId as draftIdSchema } from "@su/spec-tools-schemas";

/**
 * Read a single draft with its files + conversation.
 *
 * Visibility: status='draft' is owner-only, status='published' is
 * visible to any project-access caller (see spec-draft-store). The
 * store returns null for both "doesn't exist" and "you may not see
 * it" — we surface both as 404 so we don't leak draft existence to
 * non-owners.
 */
export default defineEventHandler(async (event) => {
  const userId = event.context.userId!;
  const projectId = event.context.projectId!;

  const rawId = getRouterParam(event, "draftId");
  const parsed = draftIdSchema.safeParse(rawId);
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: "invalid draftId" });
  }

  const draft = await getDraftWithFiles(parsed.data, projectId, userId);
  if (!draft) {
    throw createError({ statusCode: 404, statusMessage: "draft not found" });
  }

  return {
    id: draft.id,
    title: draft.title,
    baseVersion: draft.baseVersion,
    status: draft.status,
    files: draft.files,
    conversation: draft.conversation,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
    publishedAt: draft.publishedAt?.toISOString() ?? null,
  };
});
