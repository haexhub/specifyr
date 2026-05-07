import { createProjectRecord } from "@su/project-creation";
import { getAppConfigModule } from "@su/app-config";
import { DEFAULT_WORKFLOW_ID } from "@su/workflows";
import { recordProjectOwnership, type ProjectOwner } from "@su/project-store";
import { getMembership, getOrgBySlug } from "@su/org-store";

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

  // Resolve the requested owner. Empty/null/"me" → user-owned (current
  // behaviour). A slug → org-owned, but only if the caller is a member
  // of that org.
  const userId = event.context.userId;
  const ownerOrgSlug = body?.ownerOrgSlug?.trim() || null;
  let resolvedOwner: ProjectOwner | null = null;
  if (ownerOrgSlug && userId) {
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
    resolvedOwner = { kind: "org", id: org.id };
  } else if (userId) {
    resolvedOwner = { kind: "user", id: userId };
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

  // If the request was authenticated AND the DB is configured, write
  // an ownership row. Best-effort: if the DB write fails (e.g. unique
  // collision because the slug was already claimed), log it but still
  // return the FS-created record — the FS work is already committed
  // and rolling it back is more dangerous than a temporary owner-less
  // project. The org/auth phases will reconcile later.
  if (resolvedOwner) {
    try {
      await recordProjectOwnership(record.slug, resolvedOwner);
    } catch (err) {
      console.warn("[projects.post] DB ownership write failed:", err);
    }
  }

  return record;
});
