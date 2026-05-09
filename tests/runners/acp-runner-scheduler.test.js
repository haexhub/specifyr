import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunScheduler } from "../../src/core/run-scheduler.js";
import { HermesStreamingRunner } from "../../src/runners/hermes-streaming.js";

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

test("scheduler falls back to hermes when acp runner not configured", async () => {
  const sched = new RunScheduler({
    cwd: process.cwd(),
    slug: "x",
    projectCwd: process.cwd(),
    graph: { tasks: [] },
    runStore: { initFromGraph: async () => {}, setRunStatus: async () => {} },
    appConfig: {
      runner: { fallbackChain: ["acp:notconfigured", "hermes"] },
      acp: {},
      hermes: { binary: "hermes" }
    }
  });
  // Mock Hermes as available
  const originalIsAvailable = HermesStreamingRunner.isAvailable;
  HermesStreamingRunner.isAvailable = async () => true;
  try {
    const factory = await sched.pickRunner();
    assert.equal(sched._runnerName, "hermes");
  } finally {
    HermesStreamingRunner.isAvailable = originalIsAvailable;
  }
});
