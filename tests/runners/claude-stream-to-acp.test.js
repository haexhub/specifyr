import test from "node:test";
import assert from "node:assert/strict";
import { translateStreamEvent } from "../../src/runners/claude-stream-to-acp.js";

test("text block becomes one agent_message_chunk", () => {
  const out = translateStreamEvent({
    type: "assistant",
    message: { content: [{ type: "text", text: "hi" }] }
  });
  assert.deepEqual(out, [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }]);
});

test("tool_use becomes one tool_call", () => {
  const out = translateStreamEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tu_1", name: "Edit", input: { p: 1 } }] }
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionUpdate, "tool_call");
  assert.equal(out[0].toolCallId, "tu_1");
  assert.equal(out[0].title, "Edit");
  assert.equal(out[0].kind, "edit");
  assert.equal(out[0].status, "in_progress");
  assert.deepEqual(out[0].rawInput, { p: 1 });
});

test("multi-block message fans out", () => {
  const out = translateStreamEvent({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "thinking..." },
        { type: "tool_use", id: "tu_1", name: "Read", input: {} },
        { type: "text", text: "done" }
      ]
    }
  });
  assert.equal(out.length, 3);
  assert.equal(out[0].sessionUpdate, "agent_message_chunk");
  assert.equal(out[1].sessionUpdate, "tool_call");
  assert.equal(out[2].sessionUpdate, "agent_message_chunk");
});

test("tool_result becomes tool_call_update completed", () => {
  const out = translateStreamEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] }
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionUpdate, "tool_call_update");
  assert.equal(out[0].toolCallId, "tu_1");
  assert.equal(out[0].status, "completed");
});

test("tool_result with is_error becomes failed", () => {
  const out = translateStreamEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "err", is_error: true }] }
  });
  assert.equal(out[0].status, "failed");
});

test("system/result/unknown events yield []", () => {
  assert.deepEqual(translateStreamEvent({ type: "system" }), []);
  assert.deepEqual(translateStreamEvent({ type: "result", subtype: "success" }), []);
  assert.deepEqual(translateStreamEvent(null), []);
  assert.deepEqual(translateStreamEvent({}), []);
});

test("inferToolKind covers common tools", () => {
  const get = (name) => translateStreamEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "1", name, input: {} }] }
  })[0].kind;
  assert.equal(get("Read"), "read");
  assert.equal(get("Edit"), "edit");
  assert.equal(get("Write"), "edit");
  assert.equal(get("Bash"), "execute");
  assert.equal(get("Grep"), "search");
  assert.equal(get("WebFetch"), "fetch");
  assert.equal(get("Mystery"), "other");
});
