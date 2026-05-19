import { listDraftsForUser } from "@su/spec-draft-store";

/**
 * List the calling user's spec drafts for this project.
 *
 * Only returns the caller's own drafts — status='draft' rows are
 * owner-only by design (the schema comment in server/.../schema.ts
 * spells out the visibility rule). Published drafts of other users
 * are out of scope here too; they belong on the public spec endpoint
 * (Task 1.7).
 */
export default defineEventHandler(async (event) => {
  const userId = event.context.userId!;
  const projectId = event.context.projectId!;

  const drafts = await listDraftsForUser(projectId, userId);
  return {
    drafts: drafts.map((d) => ({
      id: d.id,
      title: d.title,
      baseVersion: d.baseVersion,
      status: d.status,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
      publishedAt: d.publishedAt?.toISOString() ?? null,
    })),
  };
});
