import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TurnBroker } from "../../src/core/turn-broker.js";
import { SessionStore } from "../../src/core/session-store.js";

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "turn-broker-keepalive-"));
  const sessionStore = new SessionStore(root);
  const orgId = "00000000-0000-0000-0000-000000000002";
  const slug = "x";
  const stepId = "s";
  const meta = await sessionStore.createSession(orgId, slug, stepId, { title: "t" });
  return { sessionStore, orgId, slug, stepId, sid: meta.id };
}

/**
 * Build a fake keep-alive runner that records how many times start/prompt/close
 * were called. Mirrors the AcpRunner surface the broker probes (start, prompt,
 * close, cancel, isAlive).
 */
function makeFakeKeepAliveRunner() {
  const calls = { start: 0, prompt: 0, close: 0, cancel: 0 };
  let alive = false;
  const runner = {
    calls,
    async start() {
      calls.start += 1;
      alive = true;
    },
    async prompt({ prompt, onEvent }) {
      calls.prompt += 1;
      // Emit a chunk so the broker's bookkeeping writes a real assistant message.
      await onEvent?.({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `reply-${calls.prompt}` },
      });
      return {
        exitCode: 0,
        result: { type: "result", subtype: "success", result: "", stopReason: "end_turn" },
        claudeSessionId: "stub-session",
      };
    },
    async close() {
      calls.close += 1;
      alive = false;
    },
    cancel() {
      calls.cancel += 1;
    },
    isAlive() {
      return alive;
    },
  };
  return runner;
}

test("TurnBroker reuses one keep-alive runner across multiple turns (no second start())", async () => {
  const { sessionStore, orgId, slug, stepId, sid } = await setup();
  const runner = makeFakeKeepAliveRunner();
  let factoryCalls = 0;
  const runnerFactory = () => {
    factoryCalls += 1;
    return runner;
  };
  const broker = new TurnBroker({ sessionStore, runnerFactory });

  // Turn 1
  assert.equal(broker.hasLiveSession(orgId, slug, stepId, sid), false);
  await broker.startTurn({ orgId, slug, stepId, sid, prompt: "hi", cwd: "/tmp" });
  await broker.running.get(`${orgId}|${slug}|${stepId}|${sid}`)?.promise;

  assert.equal(broker.hasLiveSession(orgId, slug, stepId, sid), true, "live after turn 1");
  assert.equal(runner.calls.start, 1, "start() called once");
  assert.equal(runner.calls.prompt, 1, "prompt() called once");
  assert.equal(runner.calls.close, 0, "no close between turns");

  // Turn 2 — same key → must reuse cached runner.
  await broker.startTurn({ orgId, slug, stepId, sid, prompt: "again", cwd: "/tmp" });
  await broker.running.get(`${orgId}|${slug}|${stepId}|${sid}`)?.promise;

  assert.equal(factoryCalls, 1, "factory must not be called a second time");
  assert.equal(runner.calls.start, 1, "start() must not be called again");
  assert.equal(runner.calls.prompt, 2, "second prompt() call");
  assert.equal(runner.calls.close, 0, "still alive between turns");

  await broker.closeAllSessions();
  assert.equal(runner.calls.close, 1, "closeAllSessions drains cache");
  assert.equal(broker.hasLiveSession(orgId, slug, stepId, sid), false);
});

test("TurnBroker.closeAllSessions drains every cached runner", async () => {
  const { sessionStore, orgId, slug, stepId, sid } = await setup();
  // Second session under the same store so the broker can write meta for both.
  const meta2 = await sessionStore.createSession(orgId, slug, stepId, { title: "t2" });
  const sid2 = meta2.id;

  const r1 = makeFakeKeepAliveRunner();
  const r2 = makeFakeKeepAliveRunner();
  const runners = [r1, r2];
  let i = 0;
  const broker = new TurnBroker({
    sessionStore,
    runnerFactory: () => runners[i++],
  });

  await broker.startTurn({ orgId, slug, stepId, sid, prompt: "a", cwd: "/tmp" });
  await broker.running.get(`${orgId}|${slug}|${stepId}|${sid}`)?.promise;
  await broker.startTurn({ orgId, slug, stepId, sid: sid2, prompt: "b", cwd: "/tmp" });
  await broker.running.get(`${orgId}|${slug}|${stepId}|${sid2}`)?.promise;

  assert.equal(broker.sessions.size, 2);
  await broker.closeAllSessions();
  assert.equal(broker.sessions.size, 0);
  assert.equal(r1.calls.close, 1);
  assert.equal(r2.calls.close, 1);
});

test("TurnBroker idle timeout closes a cached runner after inactivity", async () => {
  const { sessionStore, orgId, slug, stepId, sid } = await setup();
  const runner = makeFakeKeepAliveRunner();
  const broker = new TurnBroker({
    sessionStore,
    runnerFactory: () => runner,
    idleTimeoutMs: 30, // tight for the test
  });

  await broker.startTurn({ orgId, slug, stepId, sid, prompt: "hi", cwd: "/tmp" });
  await broker.running.get(`${orgId}|${slug}|${stepId}|${sid}`)?.promise;
  assert.equal(broker.hasLiveSession(orgId, slug, stepId, sid), true);

  // Wait past the idle window. The timer is unref'd so we have to actively wait.
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(runner.calls.close, 1, "idle timer closed the runner");
  assert.equal(broker.hasLiveSession(orgId, slug, stepId, sid), false);
});
