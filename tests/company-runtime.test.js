import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CompanyRuntime } from "../src/core/company-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const validFixture = path.join(__dirname, "fixtures", "spec-loader", "valid");

async function withTempProject(fn) {
  const proj = await fs.mkdtemp(path.join(os.tmpdir(), "cr-"));
  const queue = path.join(proj, "queue");
  await fs.mkdir(queue, { recursive: true });
  try {
    await fn({ proj, queue });
  } finally {
    await fs.rm(proj, { recursive: true, force: true });
  }
}

test("start() loads agents and provisions per-agent .hermes dirs", async () => {
  await withTempProject(async ({ proj, queue }) => {
    const runtime = new CompanyRuntime({
      projectRoot: proj,
      orgDir: validFixture,
      queueDir: queue,
      runnerFactory: () => ({ stub: true }),
    });
    await runtime.start();

    const ceoHome = path.join(proj, ".hermes", "ceo");
    const devHome = path.join(proj, ".hermes", "dev");
    assert.ok((await fs.stat(ceoHome)).isDirectory());
    assert.ok((await fs.stat(devHome)).isDirectory());

    const agents = runtime.listAgents().map((a) => a.role).sort();
    assert.deepEqual(agents, ["ceo", "dev"]);

    await runtime.stop();
  });
});

test("authorize() delegates to capability-gate for the given role", async () => {
  await withTempProject(async ({ proj, queue }) => {
    const runtime = new CompanyRuntime({
      projectRoot: proj,
      orgDir: validFixture,
      queueDir: queue,
      runnerFactory: () => ({ stub: true }),
    });
    await runtime.start();

    const allow = runtime.authorize({ role: "ceo", capability: "filesystem:read" });
    assert.equal(allow.allowed, true);

    const deny = runtime.authorize({ role: "ceo", capability: "payment:execute_unrestricted" });
    assert.equal(deny.allowed, false);

    const unknown = runtime.authorize({ role: "ghost", capability: "filesystem:read" });
    assert.equal(unknown.allowed, false);
    assert.match(unknown.reason, /unknown role/);

    await runtime.stop();
  });
});

test("emits 'task' when a yaml file is dropped into the queue", async () => {
  await withTempProject(async ({ proj, queue }) => {
    const runtime = new CompanyRuntime({
      projectRoot: proj,
      orgDir: validFixture,
      queueDir: queue,
      runnerFactory: () => ({ stub: true }),
    });
    await runtime.start();

    const taskPromise = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), 1500);
      runtime.once("task", (evt) => {
        clearTimeout(t);
        resolve(evt);
      });
    });
    await fs.writeFile(path.join(queue, "ping.yaml"), 'goal: "ping"\n');
    const evt = await taskPromise;
    assert.equal(evt.task.goal, "ping");

    await runtime.stop();
  });
});

test("rejects start() when constitution.md is missing", async () => {
  await withTempProject(async ({ proj, queue }) => {
    const orgDir = path.join(proj, "empty-org");
    await fs.mkdir(path.join(orgDir, "agents"), { recursive: true });
    const runtime = new CompanyRuntime({
      projectRoot: proj,
      orgDir,
      queueDir: queue,
      runnerFactory: () => ({ stub: true }),
    });
    await assert.rejects(() => runtime.start(), /missing constitution/);
  });
});

test("with a catalogDir, getResolvedTools/Skills hydrate references", async () => {
  await withTempProject(async ({ proj, queue }) => {
    const catalogDir = path.join(proj, "catalog");
    await fs.mkdir(path.join(catalogDir, "tools"), { recursive: true });
    await fs.mkdir(path.join(catalogDir, "skills"), { recursive: true });
    await fs.writeFile(
      path.join(catalogDir, "tools", "company-ops.yml"),
      `id: company-ops
name: "Firma-Ops"
type: mcp
transport: stdio
command: "node"
args: ["server.mjs"]
description: "test"
required_capabilities: [filesystem:read]
`
    );
    await fs.writeFile(
      path.join(catalogDir, "skills", "tdd.md"),
      `---
id: tdd
name: "TDD"
description: "Test-driven development"
---

Red green refactor.
`
    );

    const runtime = new CompanyRuntime({
      projectRoot: proj,
      orgDir: validFixture,
      queueDir: queue,
      catalogDir,
      runnerFactory: () => ({ stub: true }),
    });
    await runtime.start();

    const ceoTools = runtime.getResolvedTools("ceo");
    assert.equal(ceoTools.length, 1);
    assert.equal(ceoTools[0].id, "company-ops");

    const devSkills = runtime.getResolvedSkills("dev");
    assert.equal(devSkills.length, 1);
    assert.equal(devSkills[0].id, "tdd");
    assert.match(devSkills[0].body, /Red green refactor/);

    await runtime.stop();
  });
});

test("with a catalogDir, dangling references abort start()", async () => {
  await withTempProject(async ({ proj, queue }) => {
    const catalogDir = path.join(proj, "catalog");
    await fs.mkdir(path.join(catalogDir, "tools"), { recursive: true });
    await fs.mkdir(path.join(catalogDir, "skills"), { recursive: true });
    // Empty catalog → fixture references 'company-ops' which won't exist
    const runtime = new CompanyRuntime({
      projectRoot: proj,
      orgDir: validFixture,
      queueDir: queue,
      catalogDir,
      runnerFactory: () => ({ stub: true }),
    });
    await assert.rejects(() => runtime.start(), /catalog reference errors|E_UNKNOWN_TOOL_REFERENCE/);
  });
});
