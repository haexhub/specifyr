import fs from "node:fs/promises";
import { projectArtifactsDir, projectDir } from "@su/data-dirs";
import { deleteProjectFromDb } from "@su/project-store";

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

  await deleteProjectFromDb(orgId, slug);

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
