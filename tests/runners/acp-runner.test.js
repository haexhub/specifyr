import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpRunner } from "../../src/runners/acp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(__dirname, "..", "fixtures", "acp-stub-agent.js");

test("AcpRunner forwards stub's session/update notifications verbatim through onEvent", async () => {
  const events = [];
  const runner = new AcpRunner({
    binary: "node",
    args: [STUB],
    cwd: process.cwd(),
    onEvent: (e) => events.push(e)
  });
  const result = await runner.run({ prompt: "hello" });
  assert.equal(result.exitCode, 0);
  // Default stub script emits exactly one update:
  //   { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } }
  assert.equal(events.length, 1);
  assert.equal(events[0].sessionUpdate, "agent_message_chunk");
  assert.equal(events[0].content.text, "ok");
});

test("AcpRunner abort signal kills the agent", async () => {
  const ac = new AbortController();
  const runner = new AcpRunner({ binary: "node", args: [STUB], cwd: process.cwd() });
  const promise = runner.run({ prompt: "hello", signal: ac.signal });
  ac.abort();
  await assert.rejects(promise, /abort/i);
});

test("AcpRunner rejects (not crashes) when binary is missing on PATH", async () => {
  const runner = new AcpRunner({
    binary: "definitely-not-a-real-binary-xyz-12345",
    cwd: process.cwd()
  });
  await assert.rejects(
    runner.run({ prompt: "hello" }),
    /ACP agent spawn failed.*not found on PATH/
  );
});

test("AcpRunner forwards newSessionMeta as _meta on session/new", async () => {
  const events = [];
  const meta = { claudeCode: { options: { model: "claude-sonnet-4-6" } } };
  const runner = new AcpRunner({
    binary: "node",
    args: [STUB],
    cwd: process.cwd(),
    onEvent: (e) => events.push(e),
    newSessionMeta: meta
  });
  await runner.run({ prompt: "hello" });
  // The stub encodes the received `_meta` into a __META__-prefixed text chunk
  // emitted from newSession() — see tests/fixtures/acp-stub-agent.js.
  const echoed = events
    .filter((e) => e.sessionUpdate === "agent_message_chunk" && typeof e.content?.text === "string")
    .map((e) => e.content.text)
    .find((t) => t.startsWith("__META__"));
  assert.ok(echoed, "stub should echo _meta back via newSession");
  assert.deepEqual(JSON.parse(echoed.slice("__META__".length)), meta);
});
