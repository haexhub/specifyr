import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunScheduler } from "../../src/core/run-scheduler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(__dirname, "..", "fixtures", "acp-stub-agent.js");

test("scheduler picks AcpRunner when fallbackChain starts with acp:*", async () => {
  const sched = new RunScheduler({
    cwd: process.cwd(),
    slug: "x",
    projectCwd: process.cwd(),
    graph: { tasks: [] },
    runStore: { initFromGraph: async () => {}, setRunStatus: async () => {} },
    appConfig: {
      runner: { fallbackChain: ["acp:stub"] },
      acp: { stub: { binary: "node", args: [STUB] } }
    }
  });
  const factory = await sched.pickRunner();
  assert.equal(typeof factory, "function", "expected pickRunner to return a factory function");
  assert.equal(sched._runnerName, "acp:stub");
  const runner = factory({ cwd: process.cwd() });
  assert.equal(typeof runner.run, "function", "factory must produce a runner with a run() method");
  assert.equal(typeof runner.cancel, "function", "factory must produce a runner with a cancel() method");
});

test("scheduler skips acp:* without binary config and falls through", async () => {
  const sched = new RunScheduler({
    cwd: process.cwd(),
    slug: "x",
    projectCwd: process.cwd(),
    graph: { tasks: [] },
    runStore: { initFromGraph: async () => {}, setRunStatus: async () => {} },
    appConfig: {
      runner: { fallbackChain: ["acp:notconfigured", "claude"] },
      acp: {},
      claude: { binary: "claude" }
    }
  });
  const factory = await sched.pickRunner();
  // Should have fallen through to claude.
  assert.equal(sched._runnerName, "claude");
});
