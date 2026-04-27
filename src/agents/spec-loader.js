/**
 * spec-loader — reads `.specify/org/` artefacts (constitution + agents)
 * produced by the speckit-company extension and returns runtime-ready config
 * objects.
 *
 * The loader does NOT validate consistency — that's the validate.mjs job
 * inside speckit-company. The loader does require the files to be parseable
 * YAML frontmatter, but it tolerates missing optional fields.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Load and parse `<orgDir>/constitution.md`.
 * @returns {Promise<object|null>} parsed frontmatter, or null if file is missing.
 */
export async function loadConstitution(orgDir) {
  const p = path.join(orgDir, "constitution.md");
  try {
    const raw = await readFile(p, "utf8");
    const fm = parseFrontmatter(raw);
    if (!fm) return null;
    fm._file = p;
    return fm;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Load all agent specs from `<orgDir>/agents/`.
 *
 * @param {string} orgDir
 * @param {object} [options]
 * @param {boolean} [options.includeRetired=false]  include agents with status: retired
 * @returns {Promise<Map<string, AgentSpec>>}  keyed by role
 *
 * @throws Error('E_MISSING_AGENTS_DIR: ...') if `agents/` is absent.
 */
export async function loadAgents(orgDir, { includeRetired = false } = {}) {
  const agentsDir = path.join(orgDir, "agents");
  let entries;
  try {
    const s = await stat(agentsDir);
    if (!s.isDirectory()) {
      throw new Error(`E_MISSING_AGENTS_DIR: ${agentsDir} is not a directory`);
    }
    entries = (await readdir(agentsDir)).filter((f) => f.endsWith(".md"));
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`E_MISSING_AGENTS_DIR: ${agentsDir} does not exist`);
    }
    throw err;
  }

  const agents = new Map();
  for (const file of entries) {
    const filePath = path.join(agentsDir, file);
    const raw = await readFile(filePath, "utf8");
    const fm = parseFrontmatter(raw);
    if (!fm) continue;
    if (!fm.role) continue;
    if (!includeRetired && fm.status === "retired") continue;
    fm._file = filePath;
    fm._body = stripFrontmatter(raw);
    // normalise nested defaults
    fm.tools = fm.tools ?? { builtin: [], mcp: [] };
    fm.tools.builtin = fm.tools.builtin ?? [];
    fm.tools.mcp = fm.tools.mcp ?? [];
    fm.capabilities = fm.capabilities ?? [];
    fm.skills = fm.skills ?? [];
    fm.delivers_to = Array.isArray(fm.delivers_to) ? fm.delivers_to : [];
    agents.set(fm.role, fm);
  }
  return agents;
}

/**
 * Convenience: load constitution + agents in one call.
 */
export async function loadCompany(orgDir, options) {
  const [constitution, agents] = await Promise.all([
    loadConstitution(orgDir),
    loadAgents(orgDir, options),
  ]);
  return { constitution, agents };
}

/**
 * Validate the reporting + delivery graph.
 *
 *   - reports_to: hierarchy edges. Must form a DAG (cycles → error).
 *   - delivers_to: workflow-handoff metadata. Cycles ARE allowed
 *     (refinement loops, e.g. analyst ⇄ pipeline_builder).
 *
 * Both fields must reference known roles (typo guard).
 *
 * Throws:
 *   E_UNKNOWN_REPORTS_TO   — reports_to references unknown role
 *   E_UNKNOWN_DELIVERS_TO  — delivers_to[i] references unknown role
 *   E_REPORTS_TO_CYCLE     — reports_to chain has a cycle
 *
 * @param {Map<string, AgentSpec>} agents
 */
export function validateReportingDag(agents) {
  // Filled in by following tasks.
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  return parseYaml(match[1]);
}

function stripFrontmatter(raw) {
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
}
