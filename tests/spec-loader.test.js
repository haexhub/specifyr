import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadAgents,
  loadConstitution,
  loadCompany,
  validateReportingDag,
} from "../src/agents/spec-loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, "fixtures", "spec-loader", "valid");

test("loadConstitution parses frontmatter", async () => {
  const c = await loadConstitution(fixture);
  assert.equal(c.company_id, "test");
  assert.equal(c.operating_mode, "finite");
  assert.equal(c.budget.max_usd_per_task, 5.0);
});

test("loadAgents returns a Map keyed by role", async () => {
  const agents = await loadAgents(fixture);
  assert.ok(agents instanceof Map);
  assert.ok(agents.has("ceo"));
  assert.ok(agents.has("dev"));
});

test("loadAgents excludes retired agents by default", async () => {
  const agents = await loadAgents(fixture);
  assert.equal(agents.has("retired-bot"), false);
});

test("loadAgents includes retired when { includeRetired: true }", async () => {
  const agents = await loadAgents(fixture, { includeRetired: true });
  assert.equal(agents.has("retired-bot"), true);
});

test("loaded agent carries the file path for diagnostics", async () => {
  const agents = await loadAgents(fixture);
  const ceo = agents.get("ceo");
  assert.match(ceo._file, /agents\/ceo\.md$/);
});

test("loadCompany returns constitution and agents together", async () => {
  const company = await loadCompany(fixture);
  assert.equal(company.constitution.company_id, "test");
  assert.ok(company.agents.has("ceo"));
  // includeRetired defaults to false
  assert.equal(company.agents.has("retired-bot"), false);
});

test("loadAgents throws E_MISSING_AGENTS_DIR when agents dir is absent", async () => {
  await assert.rejects(
    () => loadAgents(path.join(__dirname, "fixtures", "spec-loader", "does-not-exist")),
    /E_MISSING_AGENTS_DIR/
  );
});

test("agent.tools.builtin is an array", async () => {
  const agents = await loadAgents(fixture);
  const dev = agents.get("dev");
  assert.ok(Array.isArray(dev.tools.builtin));
  assert.deepEqual(dev.tools.builtin, ["Read", "Edit", "Bash"]);
});

test("agent.capabilities is an array", async () => {
  const agents = await loadAgents(fixture);
  const ceo = agents.get("ceo");
  assert.ok(Array.isArray(ceo.capabilities));
  assert.ok(ceo.capabilities.includes("filesystem:read"));
});

test("agent.resources passes through nested YAML object verbatim", async () => {
  const agents = await loadAgents(fixture);
  const dev = agents.get("dev");
  assert.deepEqual(dev.resources, { cpus: "1.0", memory: "512m" });
});

// ---------------------------------------------------------------------------
// Inkrement 10a — validateReportingDag + delivers_to normalisation
// ---------------------------------------------------------------------------

test("loadAgents normalises missing delivers_to to []", async () => {
  const agents = await loadAgents(fixture);
  for (const a of agents.values()) {
    assert.ok(Array.isArray(a.delivers_to), `agent ${a.role}.delivers_to must be array`);
  }
});

test("validateReportingDag: linear hierarchy passes", () => {
  const agents = new Map([
    ["ceo", { role: "ceo", reports_to: null, delivers_to: [] }],
    ["dev", { role: "dev", reports_to: "ceo", delivers_to: [] }],
  ]);
  validateReportingDag(agents);
});
