import { createProjectRecord } from "../utils/project-creation";
import { getAppConfigModule } from "../utils/app-config";
import { DEFAULT_WORKFLOW_ID } from "../utils/workflows";

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    title?: string;
    description?: string;
    extensions?: unknown;
    workflow?: string;
  }>(event);
  const title = body?.title?.trim() ?? "";
  const description = body?.description?.trim() ?? "";

  if (!title) {
    throw createError({ statusCode: 400, statusMessage: "Project title is required." });
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

  try {
    return await createProjectRecord({ title, description, extensions, workflow });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Project could not be created.";
    const statusCode = /already exists/i.test(message) ? 409 : 400;
    throw createError({ statusCode, statusMessage: message });
  }
});
