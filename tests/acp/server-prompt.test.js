import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSpecifyrAcpAgent } from "../../src/acp/server.js";
import { encodeSessionId } from "../../src/acp/session-id.js";

class FakeBroker {
  constructor() { this.emitters = new Map(); this.cancelled = []; }
  emitterFor(slug, stepId, sid) {
    const k = `${slug}|${stepId}|${sid}`;
    if (!this.emitters.has(k)) this.emitters.set(k, new EventEmitter());
    return this.emitters.get(k);
  }
  async startTurn({ slug, stepId, sid, prompt }) {
    const e = this.emitterFor(slug, stepId, sid);
    setImmediate(() => {
      e.emit("event", {
        event: "session_update",
        data: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }
      });
      e.emit("event", { event: "done", data: {} });
      e.emit("ended");
    });
    return { startSeq: 0, prompt };
  }
  cancel(slug, stepId, sid) { this.cancelled.push([slug, stepId, sid]); }
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "specifyr-acp-prompt-"));
  const slug = "demo", stepId = "s", sid = "x";
  await mkdir(path.join(root, ".specifyr", slug, "steps", stepId, "sessions"), { recursive: true });
  await writeFile(path.join(root, ".specifyr", slug, "steps", stepId, "sessions", `${sid}.json`), "{}");
  return { root, slug, stepId, sid };
}

test("prompt forwards SessionUpdate verbatim and resolves end_turn", async () => {
  const { root, slug, stepId, sid } = await setup();
  const updates = [];
  const fakeClient = { sessionUpdate: async (n) => updates.push(n) };
  const broker = new FakeBroker();
  const agent = createSpecifyrAcpAgent({ client: fakeClient, projectRoot: root, turnBroker: broker });

  const r = await agent.prompt({
    sessionId: encodeSessionId({ slug, stepId, sid }),
    prompt: [{ type: "text", text: "hello" }]
  });
  assert.equal(r.stopReason, "end_turn");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].update.sessionUpdate, "agent_message_chunk");
  assert.equal(updates[0].update.content.text, "hi");
});

test("prompt resolves refusal when turn_failed event fires", async () => {
  const { root, slug, stepId, sid } = await setup();
  const fakeClient = { sessionUpdate: async () => {} };
  const broker = new FakeBroker();
  // Override startTurn to emit turn_failed instead.
  broker.startTurn = async ({ slug, stepId, sid }) => {
    const e = broker.emitterFor(slug, stepId, sid);
    setImmediate(() => {
      e.emit("event", { event: "turn_failed", data: { message: "boom" } });
      e.emit("ended");
    });
    return { startSeq: 0 };
  };
  const agent = createSpecifyrAcpAgent({ client: fakeClient, projectRoot: root, turnBroker: broker });
  const r = await agent.prompt({
    sessionId: encodeSessionId({ slug, stepId, sid }),
    prompt: [{ type: "text", text: "hello" }]
  });
  assert.equal(r.stopReason, "refusal");
});

test("cancel calls broker.cancel for the decoded ids", async () => {
  const { root, slug, stepId, sid } = await setup();
  const broker = new FakeBroker();
  const agent = createSpecifyrAcpAgent({ client: {}, projectRoot: root, turnBroker: broker });
  await agent.cancel({ sessionId: encodeSessionId({ slug, stepId, sid }) });
  assert.deepEqual(broker.cancelled, [[slug, stepId, sid]]);
});

test("prompt joins multiple text content blocks", async () => {
  const { root, slug, stepId, sid } = await setup();
  let lastPrompt = null;
  const fakeClient = { sessionUpdate: async () => {} };
  const broker = new FakeBroker();
  broker.startTurn = async ({ slug, stepId, sid, prompt }) => {
    lastPrompt = prompt;
    const e = broker.emitterFor(slug, stepId, sid);
    setImmediate(() => e.emit("ended"));
    return { startSeq: 0 };
  };
  const agent = createSpecifyrAcpAgent({ client: fakeClient, projectRoot: root, turnBroker: broker });
  await agent.prompt({
    sessionId: encodeSessionId({ slug, stepId, sid }),
    prompt: [{ type: "text", text: "hello" }, { type: "text", text: "world" }]
  });
  assert.equal(lastPrompt, "hello\nworld");
});
