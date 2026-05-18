import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpRunner } from "../../src/runners/acp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(__dirname, "..", "fixtures", "acp-stub-agent.js");

test("AcpRunner keep-alive: start() → prompt() x2 → close() reuses one child process", async () => {
  const events = [];
  const runner = new AcpRunner({
    binary: "node",
    args: [STUB],
    cwd: process.cwd(),
    onEvent: (e) => events.push(e),
  });

  assert.equal(runner.isAlive(), false, "not alive before start()");
  await runner.start();
  assert.equal(runner.isAlive(), true, "alive after start()");
  const pid = runner.child.pid;
  assert.ok(pid > 0);

  const r1 = await runner.prompt({ prompt: "first" });
  assert.equal(r1.exitCode, 0);
  assert.ok(r1.claudeSessionId, "claudeSessionId must be reported after first prompt");
  const sessionId1 = r1.claudeSessionId;

  // Still alive between prompts, same child pid → keep-alive proof.
  assert.equal(runner.isAlive(), true, "alive between prompts");
  assert.equal(runner.child.pid, pid, "same child process across prompts");

  const r2 = await runner.prompt({ prompt: "second" });
  assert.equal(r2.exitCode, 0);
  assert.equal(r2.claudeSessionId, sessionId1, "session id stable across prompts");

  await runner.close();
  assert.equal(runner.isAlive(), false, "not alive after close()");
});

test("AcpRunner keep-alive: per-prompt onEvent overrides the default sink for that call only", async () => {
  const defaultEvents = [];
  const turn2Events = [];
  const runner = new AcpRunner({
    binary: "node",
    args: [STUB],
    cwd: process.cwd(),
    onEvent: (e) => defaultEvents.push(e),
  });

  await runner.start();
  await runner.prompt({ prompt: "turn 1" });
  await runner.prompt({ prompt: "turn 2", onEvent: (e) => turn2Events.push(e) });
  await runner.prompt({ prompt: "turn 3" });
  await runner.close();

  // Each prompt produces one "ok" agent_message_chunk per stub script. The
  // override only redirects turn 2; turns 1 and 3 go to the default sink.
  const okChunks = (arr) => arr.filter(
    (e) => e?.sessionUpdate === "agent_message_chunk" && e.content?.text === "ok",
  );
  assert.equal(okChunks(turn2Events).length, 1, "turn 2 redirected");
  assert.equal(okChunks(defaultEvents).length, 2, "turns 1+3 went to default");
});

test("AcpRunner.run() one-shot still works for RunScheduler callers", async () => {
  // Regression: the refactor must not break the single-call API.
  const events = [];
  const runner = new AcpRunner({
    binary: "node",
    args: [STUB],
    cwd: process.cwd(),
    onEvent: (e) => events.push(e),
  });
  const result = await runner.run({ prompt: "hello" });
  assert.equal(result.exitCode, 0);
  assert.equal(runner.isAlive(), false, "run() closes the child on exit");
  assert.equal(events.length, 1);
  assert.equal(events[0].content.text, "ok");
});

test("AcpRunner.prompt() rejects after close()", async () => {
  const runner = new AcpRunner({ binary: "node", args: [STUB], cwd: process.cwd() });
  await runner.start();
  await runner.close();
  await assert.rejects(runner.prompt({ prompt: "x" }), /not started or has been closed/);
});

function scriptArg(obj) {
  return `--script=${Buffer.from(JSON.stringify(obj), "utf8").toString("base64")}`;
}

test("AcpRunner.start({resumeSessionId}) takes session/load path when agent advertises capability", async () => {
  const events = [];
  const runner = new AcpRunner({
    binary: "node",
    args: [STUB, scriptArg({ supportsLoadSession: true, updates: [], stopReason: "end_turn" })],
    cwd: process.cwd(),
    onEvent: (e) => events.push(e),
  });

  await runner.start({ resumeSessionId: "prev-session-xyz" });
  assert.equal(runner.resumedFromDisk, true, "took the loadSession path");
  assert.equal(runner.capabilities?.loadSession, true);

  // The stub emits a __LOADED__ marker chunk during loadSession.
  const loaded = events.find(
    (e) => e?.sessionUpdate === "agent_message_chunk" && e.content?.text?.startsWith("__LOADED__"),
  );
  assert.ok(loaded, "stub must emit __LOADED__ marker on session/load");
  assert.equal(loaded.content.text, "__LOADED__prev-session-xyz");

  // The session id reported to callers must be the resumed one, not a fresh one.
  const result = await runner.prompt({ prompt: "continue" });
  assert.equal(result.claudeSessionId, "prev-session-xyz");
  await runner.close();
});

test("AcpRunner falls back to newSession when loadSession fails (e.g. agent state wiped)", async () => {
  const errs = [];
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    errs.push(String(chunk));
    return origStderrWrite(chunk, ...rest);
  };
  try {
    const runner = new AcpRunner({
      binary: "node",
      args: [STUB, scriptArg({ rejectLoadSession: true, updates: [], stopReason: "end_turn" })],
      cwd: process.cwd(),
    });
    await runner.start({ resumeSessionId: "lost-session-id" });
    assert.equal(runner.resumedFromDisk, false, "fallback path taken");
    // Fresh newSession id is what the stub returns, not the resume id.
    const result = await runner.prompt({ prompt: "hi" });
    assert.equal(result.claudeSessionId, "stub-session-1");
    assert.ok(
      errs.some((s) => /loadSession.*failed.*falling back/.test(s)),
      "must log the fallback to stderr so operators can see it",
    );
    await runner.close();
  } finally {
    process.stderr.write = origStderrWrite;
  }
});

test("AcpRunner skips loadSession entirely when agent doesn't advertise the capability", async () => {
  const runner = new AcpRunner({
    binary: "node",
    args: [STUB], // default script → loadSession: false
    cwd: process.cwd(),
  });
  await runner.start({ resumeSessionId: "some-id" });
  assert.equal(runner.capabilities?.loadSession, false);
  assert.equal(runner.resumedFromDisk, false);
  await runner.close();
});
