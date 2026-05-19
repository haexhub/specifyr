import { publishDraft } from "@su/spec-draft-store";
import { readPublicSpecFiles } from "@su/spec-public-state";
import {
  draftId as draftIdSchema,
  publishDraftBody,
} from "@su/spec-tools-schemas";
import { parseBody } from "@su/validation";

/**
 * Publish a draft via compare-and-swap on `projects.spec_public_version`.
 *
 * Body must be `{}` (strict). The endpoint is intentionally
 * parameter-free — what gets published is *the draft as it stands*,
 * which the browser must have PATCH'd into the desired final shape
 * before calling publish. This avoids racy "publish a thing that
 * isn't what was on screen" failure modes.
 *
 * Outcomes:
 *   200 — `{ ok: true, newPublicVersion }`
 *   404 — draft not found OR not yours (we don't distinguish)
 *   409 — `{ conflict: true, currentPublicVersion, currentPublicFiles }`
 *         The public version moved since the draft was forked. The UI
 *         can render a diff from `currentPublicFiles` and the user
 *         chooses how to reconcile.
 */
export default defineEventHandler(async (event) => {
  const userId = event.context.userId!;
  const orgId = event.context.orgId!;
  const projectId = event.context.projectId!;
  const projectSlug = event.context.projectSlug!;

  const rawId = getRouterParam(event, "draftId");
  const parsedId = draftIdSchema.safeParse(rawId);
  if (!parsedId.success) {
    throw createError({ statusCode: 400, statusMessage: "invalid draftId" });
  }
  // The empty-body schema rejects extraneous keys (strict()), giving
  // us a guard against misuse like {force:true} that future readers
  // might assume is a thing.
  await parseBody(event, publishDraftBody);

  const result = await publishDraft(
    parsedId.data,
    projectId,
    orgId,
    projectSlug,
    userId,
  );

  if ("ok" in result) {
    return { ok: true as const, newPublicVersion: result.newPublicVersion };
  }

  if (result.error === "conflict") {
    // 409 + current state so the UI can render the diff in-place
    // without a second round-trip.
    setResponseStatus(event, 409);
    const currentPublicFiles = await readPublicSpecFiles(orgId, projectSlug);
    return {
      conflict: true as const,
      currentPublicVersion: result.currentPublicVersion,
      currentPublicFiles,
    };
  }

  throw createError({ statusCode: 404, statusMessage: "draft not found" });
});
