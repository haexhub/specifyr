import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeRunner } from "../../src/runners/claude-code.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(__dirname, "..", "fixtures", "claude-stream-stub.js");

test("ClaudeCodeRunner emits SessionUpdate shapes (not stream-json) via onEvent", async () => {
  const events = [];
  const runner = new ClaudeCodeRunner({
    binary: "node",
    args: [STUB],          // see Step 0 — add this option to ClaudeCodeRunner if missing
    cwd: process.cwd(),
    onEvent: (e) => events.push(e)
  });
  const result = await runner.run({ prompt: "hello" });
  assert.equal(result.exitCode, 0);

  // Every onEvent payload must be an ACP SessionUpdate (has .sessionUpdate field).
  for (const e of events) {
    assert.ok(typeof e.sessionUpdate === "string",
      `expected SessionUpdate, got ${JSON.stringify(e).slice(0, 200)}`);
  }

  // Concrete checks: text → agent_message_chunk; tool_use → tool_call; tool_result → tool_call_update.
  const kinds = events.map((e) => e.sessionUpdate);
  assert.ok(kinds.includes("agent_message_chunk"), `kinds: ${kinds}`);
  assert.ok(kinds.includes("tool_call"), `kinds: ${kinds}`);
  assert.ok(kinds.includes("tool_call_update"), `kinds: ${kinds}`);

  // claudeSessionId is still extracted from system/result events (runner-internal metadata).
  assert.equal(result.claudeSessionId, "stub-claude-1");
});
