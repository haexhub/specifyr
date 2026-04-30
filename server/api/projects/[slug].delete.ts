import path from "node:path";
import fs from "node:fs/promises";
import { dataDir, projectsDir } from "@su/data-dirs";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }

  const specopsDir = path.join(dataDir(), ".specops", slug);
  const projectDir = path.join(projectsDir(), slug);

  const removed: string[] = [];
  const failures: string[] = [];

  for (const target of [specopsDir, projectDir]) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      removed.push(target);
    } catch (error) {
      failures.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
