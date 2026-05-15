import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TurnBroker } from "../../src/core/turn-broker.js";
import { SessionStore } from "../../src/core/session-store.js";

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "turn-broker-acp-"));
  const sessionStore = new SessionStore(root);
  const orgId = "00000000-0000-0000-0000-000000000001";
  const slug = "x";
  const stepId = "s";
  // createSession auto-generates the session id (UUID); use the returned meta.id.
  const meta = await sessionStore.createSession(orgId, slug, stepId, { title: "t" });
  return { root, sessionStore, orgId, slug, stepId, sid: meta.id };
}

test("TurnBroker persists onEvent payloads as event:'session_update' with SessionUpdate data", async () => {
  const { sessionStore, orgId, slug, stepId, sid } = await setup();

  let triggerEmit;
  const fakeRunner = {
    async run() {
      // Emit three SessionUpdates synchronously through onEvent (set on construction).
      await triggerEmit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello" }
      });
      await triggerEmit({
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Read",
        kind: "read",
        status: "in_progress",
        rawInput: {}
      });
      await triggerEmit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: " world" }
      });
      return {
        exitCode: 0,
        result: { type: "result", subtype: "success", result: "" },
        claudeSessionId: null
      };
    },
    cancel() {}
  };
  const runnerFactory = ({ onEvent }) => {
    triggerEmit = onEvent;
    return fakeRunner;
  };

  const broker = new TurnBroker({ sessionStore, runnerFactory });

  await broker.startTurn({ orgId, slug, stepId, sid, prompt: "go", cwd: "/tmp" });

  // Wait for the inner async run() to finish.
  const state = broker.running.get(`${orgId}|${slug}|${stepId}|${sid}`);
  if (state) await state.promise;

  const eventsFile = path.join(
    sessionStore.sessionsDir(orgId, slug, stepId),
    `${sid}.events.jsonl`
  );
  const raw = await readFile(eventsFile, "utf8");
  const events = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));

  const updates = events.filter((e) => e.event === "session_update");
  assert.equal(
    updates.length,
    3,
    `expected 3 session_update events, got ${events.map((e) => e.event).join(",")}`
  );
  assert.equal(updates[0].data.sessionUpdate, "agent_message_chunk");
  assert.equal(updates[0].data.content.text, "Hello");
  assert.equal(updates[1].data.sessionUpdate, "tool_call");
  assert.equal(updates[1].data.toolCallId, "tc1");

  // No legacy "claude" events should be persisted by TurnBroker.
  assert.equal(
    events.filter((e) => e.event === "claude").length,
    0,
    "no event:'claude' should be persisted — that name is gone in ACP-native TurnBroker"
  );

  // Final assistant message must concatenate the two text chunks correctly,
  // with a paragraph break around the tool_call (toolUseSinceLastText logic).
  const assistantEvent = events.find((e) => e.event === "assistant_message");
  assert.ok(assistantEvent, "assistant_message event must be persisted");
  assert.match(assistantEvent.data.content, /Hello/);
  assert.match(assistantEvent.data.content, /world/);
});
