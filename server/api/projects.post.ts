import { createProjectRecord } from "@su/project-creation";
import { getAppConfigModule } from "@su/app-config";
import { DEFAULT_WORKFLOW_ID } from "@su/workflows";
import { recordProjectOwnership } from "@su/project-store";
import { getMembership, getOrgBySlug, listOrgsForUser } from "@su/org-store";

/**
 * Create a project. Mandatory-org model: every project belongs to an
 * org. Resolution order for the owning org:
 *   1. `ownerOrgSlug` from the body (caller must be a member)
 *   2. the caller's only org if they have exactly one
 *   3. 400 — caller must pick an org
 *
 * Authenticated callers without any org membership are sent to the
 * onboarding flow (UI redirect) rather than allowed to create a
 * project; the API surface treats it as a 400.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    title?: string;
    description?: string;
    extensions?: unknown;
    workflow?: string;
    ownerOrgSlug?: string | null;
  }>(event);
  const title = body?.title?.trim() ?? "";
  const description = body?.description?.trim() ?? "";

  if (!title) {
    throw createError({ statusCode: 400, statusMessage: "Project title is required." });
  }

  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }

  const ownerOrgSlug = body?.ownerOrgSlug?.trim() || null;
  let ownerOrgId: string | null = null;
  if (ownerOrgSlug) {
    const org = await getOrgBySlug(ownerOrgSlug);
    if (!org) {
      throw createError({ statusCode: 404, statusMessage: "Owner org not found." });
    }
    const membership = await getMembership(org.id, userId);
    if (!membership) {
      throw createError({
        statusCode: 403,
        statusMessage: "You are not a member of the selected org.",
      });
    }
    ownerOrgId = org.id;
  } else {
    const orgs = await listOrgsForUser(userId);
    if (orgs.length === 1) {
      ownerOrgId = orgs[0]!.id;
    } else if (orgs.length === 0) {
      throw createError({
        statusCode: 400,
        statusMessage:
          "Create or join an organization before creating a project.",
      });
    } else {
      throw createError({
        statusCode: 400,
        statusMessage:
          "ownerOrgSlug is required when you belong to multiple organizations.",
      });
    }
  }

  // Any string id is accepted at create-time (the extension that provides this workflow may still
  // be installing and thus not yet discoverable). Invalid ids fall back to spec-kit on first read.
  const workflow =
    typeof body?.workflow === "string" && body.workflow.trim().length > 0
      ? body.workflow.trim()
      : DEFAULT_WORKFLOW_ID;

  // If client didn't specify extensions, fall back to the current standard list.
  let extensions: string[];
  if (Array.isArray(body?.extensions)) {
    extensions = body.extensions.map((x) => String(x).trim()).filter(Boolean);
  } else {
    const { loadAppConfig } = await getAppConfigModule();
    const cfg = await loadAppConfig();
    extensions = cfg.standardExtensions;
  }

  let record;
  try {
    record = await createProjectRecord({ title, description, extensions, workflow });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Project could not be created.";
    const statusCode = /already exists/i.test(message) ? 409 : 400;
    throw createError({ statusCode, statusMessage: message });
  }

  // FS work already committed; the DB write is best-effort. A failed
  // ownership row leaves a dangling FS project that the user can
  // delete or that a future reconciliation step picks up.
  try {
    await recordProjectOwnership(record.slug, { ownerOrgId });
  } catch (err) {
    console.warn("[projects.post] DB ownership write failed:", err);
  }

  return record;
});
