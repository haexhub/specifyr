import path from "node:path";
import fs from "node:fs/promises";
import { getActiveScheduler } from "../../../../utils/run-manager";

// Keep in sync with src/core/constants.js — inlined so Nitro doesn't try to
// bundle src/ files via a static relative import (which fails at runtime).
const SPECOPS_DIR = ".specops";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }

  const cwd = process.cwd();
  const currentPath = path.join(cwd, SPECOPS_DIR, slug, "run", "current.json");
  const graphPath = path.join(cwd, SPECOPS_DIR, slug, "tasks.graph.json");

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
