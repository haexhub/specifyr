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

test("validateReportingDag: rejects unknown reports_to with E_UNKNOWN_REPORTS_TO", () => {
  const agents = new Map([
    ["dev", { role: "dev", reports_to: "ghost", delivers_to: [] }],
  ]);
  assert.throws(() => validateReportingDag(agents), /E_UNKNOWN_REPORTS_TO.*dev.*ghost/);
});

test("validateReportingDag: rejects unknown delivers_to with E_UNKNOWN_DELIVERS_TO", () => {
  const agents = new Map([
    ["ceo", { role: "ceo", reports_to: null, delivers_to: [] }],
    ["dev", { role: "dev", reports_to: "ceo", delivers_to: ["ghost"] }],
  ]);
  assert.throws(() => validateReportingDag(agents), /E_UNKNOWN_DELIVERS_TO.*dev.*ghost/);
});

test("validateReportingDag: rejects 2-node reports_to cycle", () => {
  const agents = new Map([
    ["a", { role: "a", reports_to: "b", delivers_to: [] }],
    ["b", { role: "b", reports_to: "a", delivers_to: [] }],
  ]);
  assert.throws(() => validateReportingDag(agents), /E_REPORTS_TO_CYCLE/);
});

test("validateReportingDag: rejects 3-node reports_to cycle", () => {
  const agents = new Map([
    ["a", { role: "a", reports_to: "b", delivers_to: [] }],
    ["b", { role: "b", reports_to: "c", delivers_to: [] }],
    ["c", { role: "c", reports_to: "a", delivers_to: [] }],
  ]);
  assert.throws(() => validateReportingDag(agents), /E_REPORTS_TO_CYCLE/);
});

test("validateReportingDag: rejects self-loop reports_to", () => {
  const agents = new Map([
    ["a", { role: "a", reports_to: "a", delivers_to: [] }],
  ]);
  assert.throws(() => validateReportingDag(agents), /E_REPORTS_TO_CYCLE/);
});

test("validateReportingDag: tolerates delivers_to cycles (refinement loops)", () => {
  // Trading-Workflow-Beispiel: pipeline_builder ⇄ analyst Refinement-Loop.
  // Reports-Hierarchie ist dennoch ein Baum (alle reporten an ceo).
  const agents = new Map([
    ["ceo",              { role: "ceo",              reports_to: null,  delivers_to: [] }],
    ["pipeline_builder", { role: "pipeline_builder", reports_to: "ceo", delivers_to: ["analyst"] }],
    ["analyst",          { role: "analyst",          reports_to: "ceo", delivers_to: ["pipeline_builder"] }],
  ]);
  validateReportingDag(agents); // muss NICHT werfen
});

test("validateReportingDag: tolerates delivers_to self-loop", () => {
  const agents = new Map([
    ["ceo", { role: "ceo", reports_to: null,  delivers_to: [] }],
    ["dev", { role: "dev", reports_to: "ceo", delivers_to: ["dev"] }],
  ]);
  validateReportingDag(agents);
});

test("loadCompany: rejects org with reports_to cycle", async () => {
  const dir = path.join(__dirname, "fixtures", "spec-loader", "reports-cycle");
  await assert.rejects(() => loadCompany(dir), /E_REPORTS_TO_CYCLE/);
});

test("loadCompany: ACCEPTS org with delivers_to cycle (refinement loop)", async () => {
  const dir = path.join(__dirname, "fixtures", "spec-loader", "delivers-cycle");
  const company = await loadCompany(dir);
  assert.equal(company.agents.size, 3);
});
