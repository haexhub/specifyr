import fs from "node:fs/promises";
import { projectArtifactsDir, projectDir } from "@su/data-dirs";
import { deleteProjectFromDb } from "@su/project-store";
import { deleteAllProjectSecrets } from "@su/secrets-store";

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;

  const specifyrDir = projectArtifactsDir(orgId, slug);
  const projDir = projectDir(orgId, slug);

  const removed: string[] = [];
  const failures: string[] = [];

  for (const target of [specifyrDir, projDir]) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      removed.push(target);
    } catch (error) {
      failures.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Project secrets live in the per-org schema keyed by project_slug — no
  // cross-schema FK to cascade for us, so the application owns cleanup.
  try {
    await deleteAllProjectSecrets(orgId, slug);
    removed.push("db:project_secrets");
  } catch (error) {
    failures.push(`db:project_secrets: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await deleteProjectFromDb(orgId, slug);
    removed.push("db:project_row");
  } catch (error) {
    failures.push(`db:project_row: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (failures.length && !removed.length) {
    throw createError({
      statusCode: 500,
      statusMessage: `Project could not be removed: ${failures.join("; ")}`
    });
  }

  return {
    slug,
    removed,
    failures: failures.length ? failures : undefined
  };
});
