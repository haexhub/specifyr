import path from "node:path";
import fs from "node:fs/promises";
import { getActiveScheduler } from "@su/run-manager";
import { projectArtifactsDir } from "@su/data-dirs";
import { resolveProjectOrgId } from "@su/project-store";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }

  // TODO(phase-3): drop DB lookup once project-access middleware sets event.context.orgId.
  const orgId = await resolveProjectOrgId(slug);

  const base = projectArtifactsDir(orgId, slug);
  const currentPath = path.join(base, "run", "current.json");
  const graphPath = path.join(base, "tasks.graph.json");

  let current = null;
  let graph = null;

  try {
    current = JSON.parse(await fs.readFile(currentPath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }

  try {
    graph = JSON.parse(await fs.readFile(graphPath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }

  return {
    slug,
    running: Boolean(getActiveScheduler(slug)),
    current,
    graph
  };
});
