import { createDraftBody } from "@su/spec-tools-schemas";
import { createDraft } from "@su/spec-draft-store";
import { parseBody } from "@su/validation";

/**
 * Create a new spec draft for the calling user in this project.
 *
 * The draft is created with status='draft', owned by the caller.
 * Files are stored as a set (replaced wholesale on PATCH); conversation
 * is stored as a JSON array of Vercel-AI-SDK messages.
 *
 * Auth: `project-access` middleware ensures the caller is allowed in
 * this project. Anyone who can see the project can create drafts —
 * drafts are per-user, not per-project-admin.
 */
export default defineEventHandler(async (event) => {
  const userId = event.context.userId!;
  const projectId = event.context.projectId!;
  const body = await parseBody(event, createDraftBody);

  const created = await createDraft({
    projectId,
    ownerUserId: userId,
    title: body.title,
    baseVersion: body.baseVersion,
    files: body.files,
    conversation: body.conversation,
  });

  return {
    draftId: created.id,
    createdAt: created.createdAt.toISOString(),
    updatedAt: created.updatedAt.toISOString(),
  };
});
