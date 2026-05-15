import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SpecOrchestrator } from "../src/core/orchestrator.js";
import { AgentRunner } from "../src/runners/base.js";
import { ModelProvider, OpenAICompatibleProvider } from "../src/providers/base.js";
import { PatternResolver } from "../src/core/pattern-resolver.js";
import { createUiHandler } from "../src/server/app.js";
import { ConfigStore } from "../src/core/config.js";

const TEST_ORG_ID = "00000000-0000-0000-0000-000000000001";

async function createWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "specifyr-"));
}

test("full lifecycle moves from draft to completed with approvals and events", async () => {
  const cwd = await createWorkspace();
  const orchestrator = new SpecOrchestrator({ cwd });
  await orchestrator.init();

  const { slug } = await orchestrator.createSpec(TEST_ORG_ID, "Transparent Runtime");
  await orchestrator.refineSpec(TEST_ORG_ID, slug);
  await orchestrator.generatePlan(TEST_ORG_ID, slug);
  await orchestrator.generateTasks(TEST_ORG_ID, slug);
  await orchestrator.approve(TEST_ORG_ID, slug, "spec");
  await orchestrator.approve(TEST_ORG_ID, slug, "plan");
  await orchestrator.approve(TEST_ORG_ID, slug, "task_batch");
  const finalRun = await orchestrator.startRun(TEST_ORG_ID, slug);

  assert.equal(finalRun.status, "completed");
  assert.equal(finalRun.failedTaskIds.length, 0);

  const snapshot = await orchestrator.projectSnapshot(TEST_ORG_ID, slug);
  assert.match(snapshot.spec, /Refinement Notes/);
  assert.match(snapshot.plan, /Execution Plan/);
  assert.match(snapshot.tasks, /Work Items/);
  assert.ok(snapshot.events.some((event) => event.type === "run.finished"));
  const mirroredSpec = await fs.readFile(path.join(cwd, ".specify", "specs", slug, "spec.md"), "utf8");
  assert.match(mirroredSpec, /Refinement Notes/);
});

test("execution is blocked when approval is missing", async () => {
  const cwd = await createWorkspace();
  const orchestrator = new SpecOrchestrator({ cwd });
  await orchestrator.init();

  const { slug } = await orchestrator.createSpec(TEST_ORG_ID, "Approval Guard");
  await orchestrator.refineSpec(TEST_ORG_ID, slug);
  await orchestrator.generatePlan(TEST_ORG_ID, slug);
  await orchestrator.generateTasks(TEST_ORG_ID, slug);

  await assert.rejects(() => orchestrator.startRun(TEST_ORG_ID, slug), /task_batch approval/);
});

test("runner contract can block unsafe tasks without scope", async () => {
  class UnsafeRunner extends AgentRunner {
    constructor() {
      super("unsafe-runner");
    }

    async execute() {
      return {
        status: "failed",
        summary: "scope missing",
        outputs: [],
        reviewStatus: "rejected",
        nextEvent: "fix_scope"
      };
    }
  }

  const cwd = await createWorkspace();
  const orchestrator = new SpecOrchestrator({ cwd, runner: new UnsafeRunner() });
  await orchestrator.init();

  const { slug } = await orchestrator.createSpec(TEST_ORG_ID, "Unsafe Runner");
  await orchestrator.refineSpec(TEST_ORG_ID, slug);
  await orchestrator.generatePlan(TEST_ORG_ID, slug);
  await orchestrator.generateTasks(TEST_ORG_ID, slug);
  await orchestrator.approve(TEST_ORG_ID, slug, "spec");
  await orchestrator.approve(TEST_ORG_ID, slug, "plan");
  await orchestrator.approve(TEST_ORG_ID, slug, "task_batch");

  const run = await orchestrator.startRun(TEST_ORG_ID, slug);
  assert.equal(run.status, "failed");
  assert.ok(run.failedTaskIds.length > 0);
});

test("openai-compatible provider fulfills model provider contract", async () => {
  const provider = new OpenAICompatibleProvider({ baseUrl: "http://localhost:1234", model: "demo" });
  const result = await provider.generate({ prompt: "Hello" }, { stage: "generic" });
  assert.equal(provider instanceof ModelProvider, true);
  assert.equal(result.config.model, "demo");
});

test("pattern resolver can be customized per stage", () => {
  const resolver = new PatternResolver({ spec_refine: "fabric:custom-refine" });
  const result = resolver.resolve("spec_refine", { slug: "example" });
  assert.equal(result.name, "fabric:custom-refine");
});

test("ui handler serves project snapshots", async () => {
  const cwd = await createWorkspace();
  const orchestrator = new SpecOrchestrator({ cwd });
  await orchestrator.init();
  const { slug } = await orchestrator.createSpec(TEST_ORG_ID, "UI Probe");
  const handler = createUiHandler({ cwd, orchestrator });
  const response = await callHandler(handler, `/api/orgs/${TEST_ORG_ID}/projects/${slug}`);
  const payload = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(payload.slug, slug);
});

test("fabric and hermes CLI integrations fall back safely when commands are unavailable", async () => {
  const cwd = await createWorkspace();
  const configStore = new ConfigStore(cwd);
  await configStore.save({
    integrations: {
      fabric: { enabled: true, command: "missing-fabric" },
      hermes: { enabled: true, command: "missing-hermes" }
    }
  });

  const orchestrator = new SpecOrchestrator({ cwd, configStore });
  await orchestrator.init();

  const { slug } = await orchestrator.createSpec(TEST_ORG_ID, "CLI Fallback");
  await orchestrator.refineSpec(TEST_ORG_ID, slug);
  await orchestrator.generatePlan(TEST_ORG_ID, slug);
  await orchestrator.generateTasks(TEST_ORG_ID, slug);
  await orchestrator.approve(TEST_ORG_ID, slug, "spec");
  await orchestrator.approve(TEST_ORG_ID, slug, "plan");
  await orchestrator.approve(TEST_ORG_ID, slug, "task_batch");
  const result = await orchestrator.startRun(TEST_ORG_ID, slug);

  assert.equal(result.status, "completed");
});

async function callHandler(handler, url) {
  const response = {
    statusCode: 200,
    headers: {},
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk) {
      this.body = chunk?.toString?.() ?? "";
      return this;
    }
  };

  const request = {
    url,
    headers: {
      host: "localhost"
    }
  };

  await handler(request, response);
  return response;
}
