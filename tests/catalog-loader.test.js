import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";

import {
  loadCatalog,
  loadTools,
  loadSkills,
  loadBinaries,
  resolveToolsForAgent,
  resolveSkillsForAgent,
  resolveBinariesForAgent,
  validateCatalogReferences,
  checkBinaryAvailability,
} from "../src/core/catalog-loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const realCatalog = path.join(__dirname, "..", "catalog");

async function makeFixtureCatalog() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-"));
  await fs.mkdir(path.join(dir, "tools"), { recursive: true });
  await fs.mkdir(path.join(dir, "skills"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "tools", "ping.yml"),
    `id: ping
name: "Ping"
type: mcp
transport: stdio
command: "ping-mcp"
args: []
env_keys: []
description: "Ping a host."
required_capabilities:
  - network:http
tags: [test]
`
  );
  await fs.writeFile(
    path.join(dir, "skills", "be-nice.md"),
    `---
id: be-nice
name: "Be Nice"
description: "Be respectful in commit messages."
tags: [culture]
---

Use kind language. Avoid blame.
`
  );
  return dir;
}

test("loadTools reads YAML files and returns Map<id, ToolSpec>", async () => {
  const tools = await loadTools(path.join(realCatalog, "tools"));
  assert.ok(tools.has("github"));
  assert.ok(tools.has("company-ops"));
  assert.equal(tools.get("github").type, "mcp");
  assert.deepEqual(tools.get("github").required_capabilities, [
    "secrets:read_env",
    "network:http",
    "account:github",
  ]);
});

test("loadSkills reads MD files and returns Map<id, SkillSpec> with body", async () => {
  const skills = await loadSkills(path.join(realCatalog, "skills"));
  assert.ok(skills.has("tdd"));
  const tdd = skills.get("tdd");
  assert.equal(tdd.id, "tdd");
  assert.match(tdd.body, /Red.*green.*refactor/is);
  assert.match(tdd.body, /^# Test-Driven Development/m);
});

test("loadCatalog returns both tools and skills", async () => {
  const c = await loadCatalog(realCatalog);
  assert.ok(c.tools instanceof Map);
  assert.ok(c.skills instanceof Map);
  assert.ok(c.tools.size >= 5);
  assert.ok(c.skills.size >= 5);
});

test("resolveToolsForAgent returns hydrated specs in order", async () => {
  const c = await loadCatalog(realCatalog);
  const agent = { role: "x", tools: { mcp: ["github", "company-ops"] } };
  const resolved = resolveToolsForAgent(agent, c);
  assert.equal(resolved.length, 2);
  assert.equal(resolved[0].id, "github");
  assert.equal(resolved[1].id, "company-ops");
});

test("resolveToolsForAgent throws on unknown tool reference", async () => {
  const c = await loadCatalog(realCatalog);
  const agent = { role: "x", tools: { mcp: ["nonexistent"] } };
  assert.throws(() => resolveToolsForAgent(agent, c), /unknown tool 'nonexistent'/);
});

test("resolveSkillsForAgent returns hydrated specs", async () => {
  const c = await loadCatalog(realCatalog);
  const agent = { role: "x", skills: ["tdd", "verification-before-completion"] };
  const resolved = resolveSkillsForAgent(agent, c);
  assert.equal(resolved.length, 2);
  assert.equal(resolved[0].id, "tdd");
  assert.match(resolved[0].body, /Red/);
});

test("validateCatalogReferences flags unknown tools", async () => {
  const c = await loadCatalog(realCatalog);
  const agents = [
    { role: "ceo", tools: { mcp: ["github", "ghosttool"] }, skills: [], capabilities: [] },
  ];
  const findings = validateCatalogReferences(agents, c);
  const codes = findings.map((f) => f.code);
  assert.ok(codes.includes("E_UNKNOWN_TOOL_REFERENCE"));
});

test("validateCatalogReferences flags unknown skills", async () => {
  const c = await loadCatalog(realCatalog);
  const agents = [
    { role: "ceo", tools: { mcp: [] }, skills: ["nonexistent-skill"], capabilities: [] },
  ];
  const findings = validateCatalogReferences(agents, c);
  const codes = findings.map((f) => f.code);
  assert.ok(codes.includes("E_UNKNOWN_SKILL_REFERENCE"));
});

test("validateCatalogReferences does NOT enforce required_capabilities — runtime job", async () => {
  // github tool declares required_capabilities, but the validator now only
  // checks reference existence. An agent that references a tool without the
  // declared capabilities should pass validation; runtime enforcement catches
  // mismatches at actual invocation.
  const c = await loadCatalog(realCatalog);
  const agents = [
    {
      role: "ceo",
      tools: { mcp: ["github"] },
      skills: [],
      capabilities: ["filesystem:read"], // intentionally missing the github reqs
    },
  ];
  const findings = validateCatalogReferences(agents, c);
  assert.deepEqual(findings, []);
});

test("validateCatalogReferences passes when references and caps line up", async () => {
  const c = await loadCatalog(realCatalog);
  const agents = [
    {
      role: "ceo",
      tools: { mcp: ["company-ops"] }, // requires filesystem:read
      skills: ["tdd"],
      capabilities: ["filesystem:read"],
    },
  ];
  const findings = validateCatalogReferences(agents, c);
  assert.deepEqual(findings, []);
});

test("loadCatalog tolerates a fixture catalog with arbitrary entries", async () => {
  const dir = await makeFixtureCatalog();
  try {
    const c = await loadCatalog(dir);
    assert.ok(c.tools.has("ping"));
    assert.ok(c.skills.has("be-nice"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadCatalog returns empty Maps when dirs are missing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "empty-catalog-"));
  try {
    const c = await loadCatalog(dir);
    assert.equal(c.tools.size, 0);
    assert.equal(c.skills.size, 0);
    assert.equal(c.binaries.size, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadBinaries reads YAML files and returns Map<id, BinarySpec>", async () => {
  const bins = await loadBinaries(path.join(realCatalog, "binaries"));
  assert.ok(bins.has("python3"));
  assert.ok(bins.has("gh"));
  assert.equal(bins.get("python3").type, "binary");
  assert.equal(bins.get("python3").command, "python3");
});

test("loadCatalog includes binaries", async () => {
  const c = await loadCatalog(realCatalog);
  assert.ok(c.binaries instanceof Map);
  assert.ok(c.binaries.size >= 5);
});

test("resolveBinariesForAgent returns hydrated specs", async () => {
  const c = await loadCatalog(realCatalog);
  const agent = { role: "dev", tools: { binaries: ["python3", "git"] } };
  const resolved = resolveBinariesForAgent(agent, c);
  assert.equal(resolved.length, 2);
  assert.equal(resolved[0].id, "python3");
  assert.equal(resolved[1].id, "git");
});

test("resolveBinariesForAgent throws on unknown binary", async () => {
  const c = await loadCatalog(realCatalog);
  const agent = { role: "x", tools: { binaries: ["nonexistent"] } };
  assert.throws(() => resolveBinariesForAgent(agent, c), /unknown binary 'nonexistent'/);
});

test("validateCatalogReferences flags unknown binary references", async () => {
  const c = await loadCatalog(realCatalog);
  const agents = [
    {
      role: "dev",
      tools: { mcp: [], binaries: ["ghosttool"] },
      skills: [],
      capabilities: ["shell:execute"],
    },
  ];
  const findings = validateCatalogReferences(agents, c);
  const codes = findings.map((f) => f.code);
  assert.ok(codes.includes("E_UNKNOWN_BINARY_REFERENCE"));
});

test("validateCatalogReferences does NOT enforce binary required_capabilities — runtime job", async () => {
  // curl declares network:http as required; agent doesn't have it. The
  // validator no longer enforces this — the runtime gate does. So validation
  // passes here.
  const c = await loadCatalog(realCatalog);
  const agents = [
    {
      role: "dev",
      tools: { mcp: [], binaries: ["curl"] },
      skills: [],
      capabilities: ["shell:execute"],
    },
  ];
  const findings = validateCatalogReferences(agents, c);
  assert.deepEqual(findings, []);
});

test("validateCatalogReferences passes when binary caps line up", async () => {
  const c = await loadCatalog(realCatalog);
  const agents = [
    {
      role: "dev",
      tools: { mcp: [], binaries: ["python3"] },
      skills: [],
      capabilities: ["shell:execute"],
    },
  ];
  const findings = validateCatalogReferences(agents, c);
  assert.deepEqual(findings, []);
});

test("checkBinaryAvailability splits catalog into present/missing", async () => {
  const c = await loadCatalog(realCatalog);
  const { present, missing } = await checkBinaryAvailability(c);
  assert.ok(Array.isArray(present));
  assert.ok(Array.isArray(missing));
  // node should always be present in the test env
  assert.ok(present.includes("node"), "node should be present on PATH for tests");
});

test("wildcard ['*'] in tools.mcp expands to all catalog tools", async () => {
  const c = await loadCatalog(realCatalog);
  const agent = {
    role: "x",
    tools: { mcp: ["*"] },
    capabilities: ["filesystem:read", "shell:execute", "network:http", "secrets:read_env", "account:github", "account:slack"],
  };
  const resolved = resolveToolsForAgent(agent, c);
  assert.equal(resolved.length, c.tools.size);
  // includes a known seed
  assert.ok(resolved.some((t) => t.id === "company-ops"));
  assert.ok(resolved.some((t) => t.id === "github"));
});

test("wildcard ['*'] in tools.binaries expands to all catalog binaries", async () => {
  const c = await loadCatalog(realCatalog);
  const agent = {
    role: "x",
    tools: { binaries: ["*"] },
  };
  const resolved = resolveBinariesForAgent(agent, c);
  assert.equal(resolved.length, c.binaries.size);
});

test("wildcard ['*'] in skills expands to all catalog skills", async () => {
  const c = await loadCatalog(realCatalog);
  const agent = { role: "x", skills: ["*"] };
  const resolved = resolveSkillsForAgent(agent, c);
  assert.equal(resolved.length, c.skills.size);
});

test("wildcard mixed with explicit IDs still expands to all (wildcard subsumes)", async () => {
  const c = await loadCatalog(realCatalog);
  const agent = { role: "x", tools: { binaries: ["python3", "*"] } };
  const resolved = resolveBinariesForAgent(agent, c);
  assert.equal(resolved.length, c.binaries.size);
});

test("validateCatalogReferences with wildcard expands references but does not enforce capabilities", async () => {
  const c = await loadCatalog(realCatalog);
  // Agent grabs all binaries via wildcard with only shell:execute. The
  // validator just confirms the wildcard expands cleanly — no capability
  // check happens here, runtime is the gate.
  const agents = [
    {
      role: "ceo",
      tools: { mcp: [], binaries: ["*"] },
      skills: [],
      capabilities: ["shell:execute"],
    },
  ];
  const findings = validateCatalogReferences(agents, c);
  assert.deepEqual(findings, []);
});

test("validateCatalogReferences accepts wildcard when capabilities are broad enough", async () => {
  const c = await loadCatalog(realCatalog);
  // Wildcard skills work without any caps (skills don't have required_capabilities)
  const agents = [
    {
      role: "ceo",
      tools: { mcp: [], binaries: [] },
      skills: ["*"],
      capabilities: ["filesystem:read"],
    },
  ];
  const findings = validateCatalogReferences(agents, c);
  assert.deepEqual(findings, []);
});
