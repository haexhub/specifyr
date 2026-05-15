import { z } from "zod";
import { createProjectRecord } from "@su/project-creation";
import { getAppConfigModule } from "@su/app-config";
import { addProjectMember, recordProjectOwnership } from "@su/project-store";
import { parseBody } from "@su/validation";

const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(256),
  description: z.string().trim().max(4096).optional().default(""),
  extensions: z.array(z.string().trim().min(1)).optional(),
  workflow: z.string().trim().min(1).max(128).optional(),
});

/**
 * Create a project in the org identified by the URL.
 *
 * Auth (enforced by project-access middleware):
 *   - caller must be authenticated (401 otherwise)
 *   - caller must be a member of :orgSlug (403 otherwise)
 *
 * Authorization: only org admins may create projects. The membership row
 * is set by the middleware; we just check the role here.
 *
 * Project membership: the creator is auto-added as a project member so
 * they keep access if they later lose admin role.
 */
export default defineEventHandler(async (event) => {
  const userId = event.context.userId!;
  const orgId = event.context.orgId!;
  const orgRole = event.context.orgRole;
  if (orgRole !== "admin") {
    throw createError({
      statusCode: 403,
      statusMessage: "Only org admins can create projects.",
    });
  }

  const body = await parseBody(event, createProjectSchema);
  const title = body.title;
  const description = body.description ?? "";

  // If client didn't specify extensions, fall back to the current standard list.
  let extensions: string[];
  if (body.extensions) {
    extensions = body.extensions.filter(Boolean);
  } else {
    const { loadAppConfig } = await getAppConfigModule();
    const cfg = await loadAppConfig();
    extensions = cfg.standardExtensions;
  }

  let record;
  try {
    record = await createProjectRecord({
      title,
      description,
      extensions,
      workflow: body.workflow,
      ownerOrgId: orgId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Project could not be created.";
    const statusCode = /already exists/i.test(message) ? 409 : 400;
    throw createError({ statusCode, statusMessage: message });
  }

  // DB ownership row. FS work already committed; if this fails we end up
  // with an FS-only project — the orphan check in createProjectRecord
  // cleans it up on the next creation attempt for the same slug.
  let projectRow = null;
  try {
    projectRow = await recordProjectOwnership(record.slug, { ownerOrgId: orgId });
  } catch (err) {
    console.warn("[projects.post] DB ownership write failed:", err);
  }

  // Auto-add the creator as a project member so they retain access
  // even if they later get demoted from admin to member.
  if (projectRow) {
    try {
      await addProjectMember(projectRow.id, userId);
    } catch (err) {
      console.warn("[projects.post] DB project-membership write failed:", err);
    }
  }

  return { ...record, orgSlug: event.context.orgSlug };
});
