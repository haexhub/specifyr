import path from "node:path";
import fs from "node:fs/promises";
import { ensureDir, exists, readJson, writeJson } from "../utils/fs.js";
import { SPECIFY_DIR, SPECOPS_DIR } from "./constants.js";
import { ClaudeCodeRunner } from "../runners/claude-code.js";

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

const EXTRACTION_PROMPT = `You are parsing a spec-kit tasks.md file into a structured dependency graph.

Read the tasks.md content provided after the marker and output **only valid JSON** matching this schema, no prose:

{
  "tasks": [
    {
      "id": "T001",
      "title": "Short task title",
      "description": "Full task description incl. acceptance criteria",
      "dependsOn": ["T000"],
      "parallelSafe": true,
      "category": "setup|core|test|docs|other"
    }
  ]
}

Rules:
- Keep task IDs exactly as written (T001, T002 etc.). If the file uses different IDs, preserve them.
- If a task is annotated "[P]" or similar parallel marker, set parallelSafe: true; otherwise false.
- "dependsOn" may be empty. Only include explicit dependencies — do not infer.
- Omit any task that's a header/phase marker, not an actual work item.
- Output ONE JSON object. No markdown, no code fences.
`;

function extractJsonObject(text) {
  if (!text) return null;
  // Strip any markdown code fences
  const cleaned = text.replace(/^```(?:json)?\n?/gm, "").replace(/\n?```$/gm, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // try to extract the first balanced JSON object
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
    try {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }
}

/**
 * Runs a fresh Claude headless call to extract the tasks graph from a markdown file.
 * Returns the parsed graph object. Throws on failure.
 */
async function extractGraphViaClaude(projectCwd, tasksMdPath) {
  const content = await fs.readFile(tasksMdPath, "utf8");
  const runner = new ClaudeCodeRunner({ cwd: projectCwd });
  const prompt = `${EXTRACTION_PROMPT}\n\n---TASKS_MD_START---\n${content}\n---TASKS_MD_END---\n`;
  const { result } = await runner.run({ prompt });
  const finalText = typeof result?.result === "string" ? result.result : "";
  const parsed = extractJsonObject(finalText);
  if (!parsed || !Array.isArray(parsed.tasks)) {
    throw new Error("Task-Graph-Extraktion: Claude hat kein gültiges JSON geliefert.");
  }
  // Normalize
  for (const t of parsed.tasks) {
    t.id = String(t.id ?? "").trim();
    t.title = String(t.title ?? "").trim();
    t.description = String(t.description ?? "").trim();
    t.dependsOn = Array.isArray(t.dependsOn) ? t.dependsOn.map((x) => String(x).trim()).filter(Boolean) : [];
    t.parallelSafe = Boolean(t.parallelSafe);
    t.category = String(t.category ?? "other");
  }
  return parsed.tasks.filter((t) => t.id);
}

function graphFilePath(cwd, slug) {
  return path.join(cwd, SPECOPS_DIR, slug, "tasks.graph.json");
}

/**
 * Returns the cached task graph for a project. If `tasks.md` is newer than the cache
 * (or the cache doesn't exist), re-extracts via Claude.
 * Throws if no tasks.md exists yet.
 */
export async function getOrBuildTaskGraph({ cwd = process.cwd(), slug, projectCwd }) {
  const tasksMd = await findTasksMd(projectCwd);
  if (!tasksMd) {
    throw new Error("tasks.md nicht gefunden — erzeuge zuerst Tasks im Step 4.");
  }

  const graphPath = graphFilePath(cwd, slug);
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

  const tasks = await extractGraphViaClaude(projectCwd, tasksMd);
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

export async function loadTaskGraph({ cwd = process.cwd(), slug }) {
  const graphPath = graphFilePath(cwd, slug);
  return readJson(graphPath, null);
}
