import path from "node:path";
import fs from "node:fs/promises";
import { ensureDir, exists, readJson, writeJson } from "../utils/fs.js";
import { SPECIFY_DIR, SPECIFYR_DIR } from "./constants.js";

/**
 * Locates the most recently-touched feature directory under `.specify/specs/`
 * and returns the absolute path to its tasks.md, or null if nothing found.
 */
async function findTasksMd(projectCwd) {
  const specsDir = path.join(projectCwd, SPECIFY_DIR, "specs");
  if (!(await exists(specsDir))) return null;
  const entries = await fs.readdir(specsDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  if (dirs.length === 0) return null;
  // Prefer numeric-prefixed directories sorted desc (spec-kit default: 001-foo, 002-bar)
  const sorted = [...dirs].sort((a, b) => b.localeCompare(a));
  for (const dir of sorted) {
    const candidate = path.join(specsDir, dir, "tasks.md");
    if (await exists(candidate)) return candidate;
  }
  return null;
}

function categoryFor(text) {
  const lower = text.toLowerCase();
  if (/\b(test|spec|e2e|unit|integration)\b/.test(lower)) return "test";
  if (/\b(docs?|readme|documentation)\b/.test(lower)) return "docs";
  if (/\b(setup|install|config|scaffold)\b/.test(lower)) return "setup";
  if (/\b(api|server|database|schema|ui|component|runtime|runner)\b/.test(lower)) return "core";
  return "other";
}

function dependenciesFor(text) {
  const deps = new Set();
  // "blocks" intentionally NOT included: "X blocks T002" means T002 depends
  // on X, the *opposite* direction from depends/after. Mixing it here would
  // invert the edge for those tasks. Treat it as a forward edge in a separate
  // pass if we ever need to honor it.
  //
  // Capture the trailing clause (up to a sentence terminator), then let the
  // inner `matchAll(/\bT\d+\b/g)` pull every T-ID out of it. This handles
  // prose separators like "and"/"&"/"plus" without enumerating them.
  const patterns = [
    /\bdepends(?:\s+on)?:?\s*([^.;)\n]+)/gi,
    /\bafter\s+([^.;)\n]+)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      for (const dep of String(match[1] ?? "").matchAll(/\bT\d+\b/g)) {
        deps.add(dep[0]);
      }
    }
  }
  return Array.from(deps);
}

/**
 * Provider-neutral parser for spec-kit tasks.md files.
 * It recognizes normal markdown task lines containing stable IDs like T001.
 */
async function extractGraphFromMarkdown(tasksMdPath) {
  const content = await fs.readFile(tasksMdPath, "utf8");
  const tasks = [];
  let currentHeading = "other";
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      currentHeading = heading[1];
      continue;
    }
    const taskMatch = line.match(/^(?:[-*]\s+)?(?:\[[ xX]\]\s+)?(?:\[[Pp]\]\s+)?\b(T\d+)\b[:.)-]?\s*(.+)$/);
    if (!taskMatch) continue;
    const id = taskMatch[1];
    const rest = taskMatch[2].trim();
    const parallelSafe = /\[[Pp]\]/.test(line);
    const title = rest.replace(/\s+\((?:depends|after|blocks?).*?\)\s*$/i, "").trim();
    const description = [rest, `Section: ${currentHeading}`].join("\n");
    tasks.push({
      id,
      title: title || id,
      description,
      dependsOn: dependenciesFor(line).filter((dep) => dep !== id),
      parallelSafe,
      category: categoryFor(`${currentHeading} ${rest}`),
    });
  }
  if (tasks.length === 0) {
    throw new Error("Task-Graph-Extraktion: tasks.md enthält keine erkennbaren T### Tasks.");
  }
  return tasks;
}

function graphFilePath(cwd, orgId, slug) {
  return path.join(cwd, SPECIFYR_DIR, orgId, slug, "tasks.graph.json");
}

/**
 * Returns the cached task graph for a project. If `tasks.md` is newer than the cache
 * (or the cache doesn't exist), re-extracts via Claude.
 * Throws if no tasks.md exists yet.
 */
export async function getOrBuildTaskGraph({ cwd = process.cwd(), orgId, slug, projectCwd }) {
  const tasksMd = await findTasksMd(projectCwd);
  if (!tasksMd) {
    throw new Error("tasks.md nicht gefunden — erzeuge zuerst Tasks im Step 4.");
  }

  const graphPath = graphFilePath(cwd, orgId, slug);
  const [tasksStat, graphExists] = await Promise.all([fs.stat(tasksMd), exists(graphPath)]);

  if (graphExists) {
    try {
      const cached = await readJson(graphPath, null);
      if (cached && cached.tasksMdMtime >= tasksStat.mtimeMs) {
        return cached;
      }
    } catch {
      // cache corrupted, rebuild
    }
  }

  const tasks = await extractGraphFromMarkdown(tasksMd);
  const graph = {
    slug,
    tasksMdPath: path.relative(projectCwd, tasksMd),
    tasksMdMtime: tasksStat.mtimeMs,
    generatedAt: new Date().toISOString(),
    tasks
  };
  await ensureDir(path.dirname(graphPath));
  await writeJson(graphPath, graph);
  return graph;
}

export async function loadTaskGraph({ cwd = process.cwd(), orgId, slug }) {
  const graphPath = graphFilePath(cwd, orgId, slug);
  return readJson(graphPath, null);
}
