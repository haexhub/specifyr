/**
 * Sink for `GET /spec-drafts` (no draftId). The collection is
 * inherently per-user — there's no semantically useful "all drafts in
 * this project" view, and a permissive listing would leak draft titles
 * across users. Callers should use `/spec-drafts/mine` instead.
 */
export default defineEventHandler(() => {
  throw createError({
    statusCode: 404,
    statusMessage: "use /spec-drafts/mine",
  });
});
