import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HermesStreamingRunner } from "../../src/runners/hermes-streaming.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(__dirname, "..", "fixtures", "hermes-streaming-stub.js");

test("HermesStreamingRunner emits SessionUpdate shapes via onEvent", async () => {
  const events = [];
  const runner = new HermesStreamingRunner({
    binary: STUB,
    cwd: process.cwd(),
    onEvent: (e) => events.push(e)
  });
  const r = await runner.run({ prompt: "go" });
  assert.equal(r.exitCode, 0);
  // Each line printed by the stub should produce a SessionUpdate of kind agent_message_chunk.
  for (const e of events) {
    assert.equal(typeof e.sessionUpdate, "string", `expected SessionUpdate, got ${JSON.stringify(e)}`);
    assert.equal(e.sessionUpdate, "agent_message_chunk");
    assert.equal(e.content?.type, "text");
  }
  // We expect TWO chunks (or three if the trailing partial-line flush emits a third — assert >= 2).
  assert.ok(events.length >= 2, `expected at least 2 chunks, got ${events.length}`);
  const all = events.map((e) => e.content.text).join("");
  assert.match(all, /hello/);
  assert.match(all, /world/);
});
