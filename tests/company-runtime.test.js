import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CompanyRuntime, adaptTaskToWorkItem } from "../src/core/company-runtime.js";

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

test("opsToken is auto-generated as a 64-char hex string", async () => {
  await withTempProject(async ({ proj, queue }) => {
    const a = new CompanyRuntime({
      projectRoot: proj,
      orgDir: validFixture,
      queueDir: queue,
      runnerFactory: () => ({ stub: true }),
    });
    const b = new CompanyRuntime({
      projectRoot: proj,
      orgDir: validFixture,
      queueDir: queue,
      runnerFactory: () => ({ stub: true }),
    });
    assert.match(a.opsToken, /^[0-9a-f]{64}$/);
    assert.notEqual(a.opsToken, b.opsToken, "tokens should be unique per runtime");
  });
});

test("opsToken is overridable for deterministic tests", async () => {
  await withTempProject(async ({ proj, queue }) => {
    const runtime = new CompanyRuntime({
      projectRoot: proj,
      orgDir: validFixture,
      queueDir: queue,
      runnerFactory: () => ({ stub: true }),
      opsToken: "fixed-token-for-tests",
    });
    assert.equal(runtime.opsToken, "fixed-token-for-tests");
  });
});

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

// ---------------------------------------------------------------------------
// adaptTaskToWorkItem — pure unit tests (no runtime spin-up)
// ---------------------------------------------------------------------------

test("adaptTaskToWorkItem fills required fields with defaults", () => {
  const wi = adaptTaskToWorkItem({ goal: "say hi" }, "/tmp/ping.yaml");
  assert.equal(wi.goal, "say hi");
  assert.equal(wi.title, "ping");
  assert.deepEqual(wi.scope, ["ALL"]); // load-bearing default — empty scope blocks runner
  assert.deepEqual(wi.inputs, []);
  assert.deepEqual(wi.successCriteria, []);
  assert.deepEqual(wi.expectedOutputs, []);
});

test("adaptTaskToWorkItem honours snake_case AND camelCase output keys", () => {
  const snake = adaptTaskToWorkItem(
    { goal: "x", expected_outputs: ["a.md"], success_criteria: ["passes tests"] },
    "/tmp/x.yaml"
  );
  assert.deepEqual(snake.expectedOutputs, ["a.md"]);
  assert.deepEqual(snake.successCriteria, ["passes tests"]);

  const camel = adaptTaskToWorkItem(
    { goal: "y", expectedOutputs: ["b.md"], successCriteria: ["green"] },
    "/tmp/y.yaml"
  );
  assert.deepEqual(camel.expectedOutputs, ["b.md"]);
  assert.deepEqual(camel.successCriteria, ["green"]);
});

test("adaptTaskToWorkItem preserves explicit scope when provided", () => {
  const wi = adaptTaskToWorkItem(
    { goal: "z", scope: ["src/foo.ts"] },
    "/tmp/z.yaml"
  );
  assert.deepEqual(wi.scope, ["src/foo.ts"]);
});

test("adaptTaskToWorkItem tolerates null/empty task", () => {
  const wi = adaptTaskToWorkItem(null, "/tmp/empty.yaml");
  assert.equal(wi.title, "empty");
  assert.equal(wi.goal, "(no goal specified)");
});

// ---------------------------------------------------------------------------
// Dispatch loop tests
// ---------------------------------------------------------------------------

function recordingRunnerFactory(record) {
  return (agent) => {
    if (agent.role !== "ceo" && agent.role !== "dev") {
      throw new Error(`unexpected role: ${agent.role}`);
    }
    return {
      role: agent.role,
      async execute(workItem, runtimeContext) {
        record.push({ role: agent.role, workItem, runtimeContext });
        return { status: "completed", outputs: workItem.expectedOutputs };
      },
    };
  };
}

test("dispatch: drops a task in queue → CEO runner receives execute() call → file is unlinked", async () => {
  await withTempProject(async ({ proj, queue }) => {
    const calls = [];
    const runtime = new CompanyRuntime({
      projectRoot: proj,
      orgDir: validFixture,
      queueDir: queue,
      slug: "demo",
      runnerFactory: recordingRunnerFactory(calls),
    });
    await runtime.start();

    const dispatched = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("dispatch timeout")), 2000);
      runtime.once("dispatched", (p) => {
        clearTimeout(t);
        resolve(p);
      });
    });

    const taskPath = path.join(queue, "echo.yaml");
    await fs.writeFile(taskPath, 'goal: "say hi"\nexpected_outputs: ["hi.md"]\n');

    const evt = await dispatched;
    assert.equal(evt.role, "ceo");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].role, "ceo");
    assert.equal(calls[0].workItem.goal, "say hi");
    assert.equal(calls[0].runtimeContext.slug, "demo");
    assert.equal(calls[0].runtimeContext.cwd, proj);

    // wait for the unlink that follows status: completed
    await new Promise((r) => setTimeout(r, 200));
    await assert.rejects(() => fs.access(taskPath));

    await runtime.stop();
  });
});

test("dispatch: tasks process serially even if dropped concurrently", async () => {
  await withTempProject(async ({ proj, queue }) => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order = [];
    const runnerFactory = (agent) => ({
      async execute(workItem) {
        if (agent.role !== "ceo") return { status: "completed" };
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(workItem.title);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        return { status: "completed", outputs: [] };
      },
    });

    const runtime = new CompanyRuntime({
      projectRoot: proj,
      orgDir: validFixture,
      queueDir: queue,
      slug: "demo",
      runnerFactory,
    });
    await runtime.start();

    await Promise.all([
      fs.writeFile(path.join(queue, "a.yaml"), 'goal: "a"\n'),
      fs.writeFile(path.join(queue, "b.yaml"), 'goal: "b"\n'),
      fs.writeFile(path.join(queue, "c.yaml"), 'goal: "c"\n'),
    ]);

    // wait until all three are dispatched
    let dispatched = 0;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("only got " + dispatched)), 3000);
      runtime.on("dispatched", () => {
        if (++dispatched === 3) {
          clearTimeout(t);
          resolve();
        }
      });
    });

    assert.equal(maxInFlight, 1, "expected serial dispatch (1 at a time)");
    assert.deepEqual(order.sort(), ["a", "b", "c"]);

    await runtime.stop();
  });
});

test("dispatch: failed status leaves the file in place (retry on restart)", async () => {
  await withTempProject(async ({ proj, queue }) => {
    const runtime = new CompanyRuntime({
      projectRoot: proj,
      orgDir: validFixture,
      queueDir: queue,
      slug: "demo",
      runnerFactory: () => ({
        async execute() {
          return { status: "failed", outputs: [] };
        },
      }),
    });
    await runtime.start();

    const dispatched = new Promise((resolve) => runtime.once("dispatched", resolve));
    const taskPath = path.join(queue, "doomed.yaml");
    await fs.writeFile(taskPath, 'goal: "fail"\n');
    await dispatched;

    // file should still be there
    await fs.access(taskPath);
    await runtime.stop();
  });
});

// ---------------------------------------------------------------------------
// authorizeWithApproval — integration with CapabilityApprovalService
// ---------------------------------------------------------------------------

function recordingApprovalService(decision = "approved") {
  const calls = [];
  return {
    calls,
    async requestApproval(input) {
      calls.push(input);
      return { decision, by: "stub", at: new Date().toISOString(), requestId: "stub-1" };
    },
  };
}

const sensitiveOrgFixture = path.join(__dirname, "fixtures", "spec-loader", "valid");

test("authorizeWithApproval: short-circuits when capability is denied", async () => {
  await withTempProject(async ({ proj, queue }) => {
    const approvals = recordingApprovalService();
    const runtime = new CompanyRuntime({
      projectRoot: proj,
      orgDir: sensitiveOrgFixture,
      queueDir: queue,
      slug: "demo",
      runnerFactory: () => ({ stub: true }),
      approvalService: approvals,
    });
    await runtime.start();

    const result = await runtime.authorizeWithApproval({
      role: "ceo",
      capability: "payment:execute_unrestricted", // not granted to CEO fixture
    });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /not granted/);
    assert.equal(approvals.calls.length, 0, "no approval requested when denied");

    await runtime.stop();
  });
});

test("authorizeWithApproval: returns immediately when no approval is required", async () => {
  await withTempProject(async ({ proj, queue }) => {
    const approvals = recordingApprovalService();
    const runtime = new CompanyRuntime({
      projectRoot: proj,
      orgDir: sensitiveOrgFixture,
      queueDir: queue,
      slug: "demo",
      runnerFactory: () => ({ stub: true }),
      approvalService: approvals,
    });
    await runtime.start();

    const result = await runtime.authorizeWithApproval({
      role: "ceo",
      capability: "filesystem:read", // granted, non-sensitive
    });
    assert.equal(result.allowed, true);
    assert.equal(approvals.calls.length, 0, "no approval requested for non-sensitive grant");

    await runtime.stop();
  });
});

test("authorizeWithApproval: sensitive cap → calls approvalService and forwards decision", async () => {
  await withTempProject(async ({ proj, queue }) => {
    // Custom org with a CEO that has a sensitive capability granted
    const orgDir = path.join(proj, "org");
    await fs.mkdir(path.join(orgDir, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(orgDir, "constitution.md"),
      "---\nschema_version: \"1.0\"\n---\n# Co\n"
    );
    await fs.writeFile(
      path.join(orgDir, "agents", "ceo.md"),
      [
        "---",
        'schema_version: "1.0"',
        "role: ceo",
        "reports_to: null",
        "skills: []",
        "tools:",
        "  builtin: []",
        "  mcp: []",
        "capabilities: [secrets:read_vault]",
        "status: active",
        "---",
        "# CEO",
      ].join("\n")
    );

    const approvals = recordingApprovalService("approved");
    const runtime = new CompanyRuntime({
      projectRoot: proj,
      orgDir,
      queueDir: queue,
      slug: "demo",
      runnerFactory: () => ({ stub: true }),
      approvalService: approvals,
    });
    await runtime.start();

    const result = await runtime.authorizeWithApproval({
      role: "ceo",
      capability: "secrets:read_vault",
      requestPayload: { vault: "prod-credentials" },
    });
    assert.equal(result.allowed, true);
    assert.equal(approvals.calls.length, 1);
    assert.equal(approvals.calls[0].slug, "demo");
    assert.equal(approvals.calls[0].agent.role, "ceo");
    assert.equal(approvals.calls[0].capability, "secrets:read_vault");
    assert.deepEqual(approvals.calls[0].requestPayload, { vault: "prod-credentials" });
    assert.equal(result.approval.decision, "approved");

    await runtime.stop();
  });
});

test("authorizeWithApproval: denied/escalated decision → allowed=false with approval shape", async () => {
  await withTempProject(async ({ proj, queue }) => {
    const orgDir = path.join(proj, "org");
    await fs.mkdir(path.join(orgDir, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(orgDir, "constitution.md"),
      "---\nschema_version: \"1.0\"\n---\n# Co\n"
    );
    await fs.writeFile(
      path.join(orgDir, "agents", "ceo.md"),
      [
        "---",
        'schema_version: "1.0"',
        "role: ceo",
        "reports_to: null",
        "skills: []",
        "tools: { builtin: [], mcp: [] }",
        "capabilities: [secrets:read_vault]",
        "status: active",
        "---",
        "# CEO",
      ].join("\n")
    );

    const approvals = recordingApprovalService("denied");
    const runtime = new CompanyRuntime({
      projectRoot: proj,
      orgDir,
      queueDir: queue,
      slug: "demo",
      runnerFactory: () => ({ stub: true }),
      approvalService: approvals,
    });
    await runtime.start();

    const result = await runtime.authorizeWithApproval({
      role: "ceo",
      capability: "secrets:read_vault",
    });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /denied/);
    assert.equal(result.approval.decision, "denied");

    await runtime.stop();
  });
});

test("dispatch: stub runner without execute() emits 'dispatched' with null result and does not throw", async () => {
  // This is the existing test-fixture pattern — confirm we did not break
  // tests that pass `() => ({ stub: true })` runnerFactories.
  await withTempProject(async ({ proj, queue }) => {
    const runtime = new CompanyRuntime({
      projectRoot: proj,
      orgDir: validFixture,
      queueDir: queue,
      slug: "demo",
      runnerFactory: () => ({ stub: true }),
    });
    await runtime.start();

    const dispatched = new Promise((resolve) => runtime.once("dispatched", resolve));
    await fs.writeFile(path.join(queue, "stubby.yaml"), 'goal: "x"\n');
    const evt = await dispatched;
    assert.equal(evt.role, "ceo");
    assert.equal(evt.result, null);

    await runtime.stop();
  });
});
