import path from "node:path";
import fs from "node:fs/promises";
import { getActiveScheduler } from "@su/run-manager";
import { dataDir } from "@su/data-dirs";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }

  const base = path.join(dataDir(), ".specifyr", slug);
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
