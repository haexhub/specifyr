/**
 * Central tool & skill catalog loader.
 *
 * Layout:
 *   <catalogRoot>/tools/<id>.yml         tool manifest (MCP server, builtin, custom)
 *   <catalogRoot>/skills/<id>.md         skill manifest (frontmatter + body)
 *   <catalogRoot>/binaries/<id>.yml      system binary manifest (`python3`, `gh`, …)
 *
 * Agents reference catalog entries by ID in their frontmatter:
 *   tools.mcp:      [<tool-id>, …]
 *   tools.binaries: [<binary-id>, …]
 *   skills:         [<skill-id>, …]
 *
 * The runtime calls `resolveToolsForAgent` / `resolveSkillsForAgent` /
 * `resolveBinariesForAgent` to hydrate those references into full specs at
 * spawn time. The validator calls `validateCatalogReferences` to catch
 * dangling references and capability gaps before the runtime starts.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * @typedef {object} ToolSpec
 * @property {string} id
 * @property {string} name
 * @property {"mcp"|"builtin"|"custom"} type
 * @property {string} [transport]      e.g. "stdio"
 * @property {string} [command]
 * @property {string[]} [args]
 * @property {string[]} [env_keys]
 * @property {string} description
 * @property {string[]} required_capabilities
 * @property {string[]} [tags]
 * @property {string} _file
 */

/**
 * @typedef {object} SkillSpec
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string[]} [tags]
 * @property {string} body              markdown after frontmatter, used as system-prompt seed
 * @property {string} _file
 */

export async function loadCatalog(catalogRoot) {
  const [tools, skills, binaries] = await Promise.all([
    loadTools(path.join(catalogRoot, "tools")),
    loadSkills(path.join(catalogRoot, "skills")),
    loadBinaries(path.join(catalogRoot, "binaries")),
  ]);
  return { tools, skills, binaries };
}

export async function loadTools(toolsDir) {
  const out = new Map();
  if (!(await isDir(toolsDir))) return out;
  const files = (await readdir(toolsDir)).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  for (const file of files) {
    const filePath = path.join(toolsDir, file);
    const raw = await readFile(filePath, "utf8");
    const spec = parseYaml(raw);
    if (!spec || !spec.id) continue;
    spec._file = filePath;
    spec.required_capabilities = spec.required_capabilities ?? [];
    spec.env_keys = spec.env_keys ?? [];
    spec.args = spec.args ?? [];
    spec.tags = spec.tags ?? [];
    out.set(spec.id, spec);
  }
  return out;
}

export async function loadBinaries(binariesDir) {
  const out = new Map();
  if (!(await isDir(binariesDir))) return out;
  const files = (await readdir(binariesDir)).filter(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml")
  );
  for (const file of files) {
    const filePath = path.join(binariesDir, file);
    const raw = await readFile(filePath, "utf8");
    const spec = parseYaml(raw);
    if (!spec || !spec.id) continue;
    spec._file = filePath;
    spec.required_capabilities = spec.required_capabilities ?? [];
    spec.tags = spec.tags ?? [];
    spec.command = spec.command ?? spec.id;
    out.set(spec.id, spec);
  }
  return out;
}

export async function loadSkills(skillsDir) {
  const out = new Map();
  if (!(await isDir(skillsDir))) return out;
  const files = (await readdir(skillsDir)).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    const filePath = path.join(skillsDir, file);
    const raw = await readFile(filePath, "utf8");
    const fm = parseFrontmatter(raw);
    if (!fm || !fm.id) continue;
    const body = stripFrontmatter(raw);
    fm._file = filePath;
    fm.body = body;
    fm.tags = fm.tags ?? [];
    out.set(fm.id, fm);
  }
  return out;
}

/**
 * Expand a reference list against a catalog map.
 *
 * `["*"]` (or any list containing `"*"`) expands to all keys of the catalog
 * map — convenience for "give this agent everything we have". Wildcard
 * does NOT bypass capability checks; the validator still verifies each
 * expanded entry's required_capabilities against the agent's grants.
 *
 * @param {string[]} refs
 * @param {Map<string, any>} catalogMap
 * @returns {string[]} concrete IDs after wildcard expansion
 */
export function expandWildcards(refs, catalogMap) {
  if (!Array.isArray(refs) || refs.length === 0) return [];
  if (refs.includes("*")) return [...catalogMap.keys()];
  return refs;
}

/**
 * @returns {ToolSpec[]} resolved in the order the agent listed them; `["*"]` expands to all
 * @throws {Error} `unknown tool '<id>'` if any reference is missing
 */
export function resolveToolsForAgent(agent, catalog) {
  const refs = expandWildcards(agent?.tools?.mcp ?? [], catalog.tools);
  return refs.map((id) => {
    const spec = catalog.tools.get(id);
    if (!spec) throw new Error(`unknown tool '${id}' (referenced by agent '${agent.role}')`);
    return spec;
  });
}

/**
 * @returns {SkillSpec[]} resolved in the order the agent listed them; `["*"]` expands to all
 * @throws {Error} `unknown skill '<id>'` if any reference is missing
 */
export function resolveSkillsForAgent(agent, catalog) {
  const refs = expandWildcards(agent?.skills ?? [], catalog.skills);
  return refs.map((id) => {
    const spec = catalog.skills.get(id);
    if (!spec) throw new Error(`unknown skill '${id}' (referenced by agent '${agent.role}')`);
    return spec;
  });
}

/**
 * @returns {Array} resolved binary specs in the order the agent listed them; `["*"]` expands to all
 * @throws {Error} `unknown binary '<id>'` if any reference is missing
 */
export function resolveBinariesForAgent(agent, catalog) {
  const refs = expandWildcards(agent?.tools?.binaries ?? [], catalog.binaries ?? new Map());
  return refs.map((id) => {
    const spec = catalog.binaries?.get(id);
    if (!spec) throw new Error(`unknown binary '${id}' (referenced by agent '${agent.role}')`);
    return spec;
  });
}

/**
 * Validate every agent's references against the catalog.
 *
 * @returns {Array<{severity, code, message, location?}>} findings
 */
export function validateCatalogReferences(agents, catalog) {
  const findings = [];
  for (const agent of agents) {
    const role = agent.role ?? "?";
    const grantedCaps = new Set(agent.capabilities ?? []);
    const grantedClasses = new Set();
    for (const g of grantedCaps) {
      if (g.endsWith(":any")) grantedClasses.add(g.split(":")[0]);
    }

    const toolRefs = expandWildcards(agent.tools?.mcp ?? [], catalog.tools);
    for (const toolId of toolRefs) {
      const tool = catalog.tools.get(toolId);
      if (!tool) {
        findings.push({
          severity: "error",
          code: "E_UNKNOWN_TOOL_REFERENCE",
          message: `agent '${role}' references unknown tool '${toolId}'`,
          location: agent._file,
        });
        continue;
      }
      const missing = (tool.required_capabilities ?? []).filter(
        (req) => !grantedCaps.has(req) && !grantedClasses.has(req.split(":")[0])
      );
      if (missing.length > 0) {
        findings.push({
          severity: "error",
          code: "E_TOOL_CAPABILITY_MISSING",
          message: `agent '${role}' uses tool '${toolId}' which requires capabilities ${JSON.stringify(missing)} not granted to this agent`,
          location: agent._file,
        });
      }
    }

    const binRefs = expandWildcards(agent.tools?.binaries ?? [], catalog.binaries ?? new Map());
    for (const binId of binRefs) {
      const bin = catalog.binaries?.get(binId);
      if (!bin) {
        findings.push({
          severity: "error",
          code: "E_UNKNOWN_BINARY_REFERENCE",
          message: `agent '${role}' references unknown binary '${binId}'`,
          location: agent._file,
        });
        continue;
      }
      const missing = (bin.required_capabilities ?? []).filter(
        (req) => !grantedCaps.has(req) && !grantedClasses.has(req.split(":")[0])
      );
      if (missing.length > 0) {
        findings.push({
          severity: "error",
          code: "E_BINARY_CAPABILITY_MISSING",
          message: `agent '${role}' uses binary '${binId}' which requires capabilities ${JSON.stringify(missing)} not granted to this agent`,
          location: agent._file,
        });
      }
    }

    const skillRefs = expandWildcards(agent.skills ?? [], catalog.skills);
    for (const skillId of skillRefs) {
      const skill = catalog.skills.get(skillId);
      if (!skill) {
        findings.push({
          severity: "error",
          code: "E_UNKNOWN_SKILL_REFERENCE",
          message: `agent '${role}' references unknown skill '${skillId}'`,
          location: agent._file,
        });
      }
    }
  }
  return findings;
}

/**
 * Check which catalog binaries are actually present on $PATH.
 *
 * @returns {Promise<{present: string[], missing: string[]}>}
 */
export async function checkBinaryAvailability(catalog) {
  const { execFile } = await import("node:child_process");
  const present = [];
  const missing = [];
  for (const [id, spec] of catalog.binaries ?? new Map()) {
    const found = await new Promise((resolve) => {
      execFile("which", [spec.command], (err, stdout) => {
        if (err || !stdout?.trim()) resolve(false);
        else resolve(true);
      });
    });
    (found ? present : missing).push(id);
  }
  return { present, missing };
}

async function isDir(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  return parseYaml(m[1]);
}

function stripFrontmatter(raw) {
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
}
