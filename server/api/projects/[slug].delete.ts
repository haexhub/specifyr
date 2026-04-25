import path from "node:path";
import fs from "node:fs/promises";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }

  const cwd = process.cwd();
  const specopsDir = path.join(cwd, ".specops", slug);
  const projectDir = path.join(cwd, "projects", slug);

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
