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
