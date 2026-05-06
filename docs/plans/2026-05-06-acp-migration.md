# ACP Migration Implementation Plan (rev 2 — ACP as lingua franca)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use superpowers:test-driven-development for every task. Use superpowers:verification-before-completion before claiming a task done.

**Goal:** Make ACP the single internal event format throughout specifyr. All runners output ACP `SessionUpdate` objects. TurnBroker persists them natively. The ACP server-side adapter forwards them with minimal wrapping. No legacy/backward-compat shims.

**Architecture:**
- All runners implement `{ run, cancel }` and call `onEvent(sessionUpdate)` where `sessionUpdate` is an ACP `SessionUpdate` object.
- TurnBroker persists each call as `event: "session_update", data: <SessionUpdate>` to `.specifyr/<slug>/steps/<stepId>/sessions/<sid>.events.jsonl`. Plus terminal events `done` and `turn_failed` and the `session_reset` retry signal — all in ACP-friendly shapes.
- ClaudeCodeRunner ([src/runners/claude-code.js](src/runners/claude-code.js)) and HermesStreamingRunner ([src/runners/hermes-streaming.js](src/runners/hermes-streaming.js)) translate their stream-json output into SessionUpdates via a shared adapter (`src/runners/claude-stream-to-acp.js`) before calling `onEvent`. The adapter is the SINGLE place provider-specific shape lives.
- AcpRunner (`src/runners/acp.js`) is identity — it forwards `session/update` notifications from the child agent verbatim.
- The ACP server (`bin/specifyr-acp.js`) reads `session_update` events from disk and forwards them as `session/update` notifications. Resolves `session/prompt` with stopReason from the `done` event.
- SSE endpoint emits the same shape; UI consumes ACP-native data.

**Tech Stack:**
- `@agentclientprotocol/sdk@^0.21.0` (already installed in 0.1)
- Node 22+ ESM
- `node --test` for unit + integration tests
- Existing: chokidar, yaml, vue/nuxt

**Status:** Phase 0 partially done.
- ✓ Task 0.1 — SDK + typedefs (commit `bd9c5f4`)
- ✓ Task 0.2 — session-id encode/decode (commit `adb6442`)
- ✓ Task 1.1 — stub agent fixture (commit `971ece6`)
- ✗ Old Tasks 0.3 + 0.4 — REVERTED. The translate.js / fan-out approach is replaced by Tasks 1.0–1.5 below (output adapter at the runner layer, not at the read layer).

---

## Phase 1 — Make ACP the persisted event format

### Task 1.0: Output adapter — Claude/Hermes stream-json → ACP SessionUpdate

The shared translator that takes ONE stream-json event (Claude `stream-json` shape, also used by HermesStreamingRunner) and yields ZERO or MORE ACP `SessionUpdate` objects.

**Files:**
- Create: `src/runners/claude-stream-to-acp.js`
- Create: `tests/runners/claude-stream-to-acp.test.js`

**Step 1: Write the failing test**

```js
// tests/runners/claude-stream-to-acp.test.js
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
  // smoke-test the kind labels
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
```

**Step 2: Run — expect FAIL**

Run: `node --test tests/runners/claude-stream-to-acp.test.js`

**Step 3: Implement**

```js
// src/runners/claude-stream-to-acp.js
/**
 * Translate ONE Claude/Hermes stream-json event into ZERO or MORE ACP SessionUpdate objects.
 *
 * Stream-json shape (Claude CLI native, also synthesized by HermesStreamingRunner):
 *   { type: "assistant", message: { content: [{type: "text"|"tool_use", ...}, ...] } }
 *   { type: "user",      message: { content: [{type: "tool_result", ...}] } }
 *   { type: "system" | "result" | other }   ← no ACP analogue, ignored
 *
 * This is the SINGLE place provider-specific stream-json knowledge lives.
 * Old runners pipe their output through this on the way out so TurnBroker
 * never sees stream-json.
 *
 * @returns {Array<object>} zero or more SessionUpdate objects
 */
export function translateStreamEvent(event) {
  if (!event || typeof event !== "object") return [];

  if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    const out = [];
    for (const block of event.message.content) {
      const update = blockToUpdate(block);
      if (update) out.push(update);
    }
    return out;
  }

  if (event.type === "user" && Array.isArray(event.message?.content)) {
    const out = [];
    for (const block of event.message.content) {
      if (block?.type === "tool_result") {
        out.push({
          sessionUpdate: "tool_call_update",
          toolCallId: block.tool_use_id,
          status: block.is_error ? "failed" : "completed",
          content: typeof block.content === "string"
            ? [{ type: "content", content: { type: "text", text: block.content } }]
            : undefined
        });
      }
    }
    return out;
  }

  return [];
}

function blockToUpdate(block) {
  if (!block || typeof block !== "object") return null;
  if (block.type === "text") {
    return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } };
  }
  if (block.type === "tool_use") {
    return {
      sessionUpdate: "tool_call",
      toolCallId: block.id,
      title: block.name,
      kind: inferToolKind(block.name),
      status: "in_progress",
      rawInput: block.input
    };
  }
  return null;
}

function inferToolKind(name) {
  const n = String(name ?? "").toLowerCase();
  if (n === "read" || n.includes("read")) return "read";
  if (n === "edit" || n === "write" || n === "multiedit" || n.includes("write") || n.includes("edit")) return "edit";
  if (n === "bash" || n.includes("exec")) return "execute";
  if (n.includes("search") || n === "grep" || n === "glob") return "search";
  if (n.includes("fetch") || n.includes("http")) return "fetch";
  return "other";
}
```

**Step 4: Run — expect PASS**

Run: `node --test tests/runners/claude-stream-to-acp.test.js`
Expected: all 7 tests pass.

**Step 5: Commit**

```bash
git add src/runners/claude-stream-to-acp.js tests/runners/claude-stream-to-acp.test.js
git commit -m "feat(runners): output adapter from Claude stream-json to ACP SessionUpdate"
```

---

### Task 1.1: TurnBroker — persist SessionUpdate natively

**Files:**
- Modify: [src/core/turn-broker.js](src/core/turn-broker.js) — replace claude-shape walker with SessionUpdate walker
- Modify: relevant tests under `tests/` (find via `grep -rn "claude" tests/ | grep -v node_modules` — adapt asserts as needed)

**Background — what changes:**

[turn-broker.js:83-100](src/core/turn-broker.js#L83-L100) currently:
```js
const onEvent = async (claudeEvent) => {
  if (claudeEvent?.type === "assistant" && Array.isArray(claudeEvent.message?.content)) {
    for (const block of claudeEvent.message.content) {
      if (block?.type === "text" && typeof block.text === "string") {
        // ...accumulate assistantText...
      } else if (block?.type === "tool_use" && block.name) {
        toolUses.push({ name: block.name, input: block.input });
        // ...
      }
    }
  }
  await append("claude", claudeEvent);
};
```

New shape — `onEvent` receives a single `SessionUpdate`:
```js
const onEvent = async (update) => {
  if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
    // accumulate text (same toolUseSinceLastText boundary logic)
    if (toolUseSinceLastText && assistantText) assistantText += `\n\n${update.content.text}`;
    else assistantText += update.content.text;
    toolUseSinceLastText = false;
  } else if (update?.sessionUpdate === "tool_call") {
    toolUses.push({ name: update.title, input: update.rawInput });
    toolUseSinceLastText = true;
  }
  await append("session_update", update);
};
```

`assistant_message`, `done`, `turn_failed`, `session_reset` event names remain as before — they are TurnBroker's own bookkeeping events, not stream events.

**Step 1: Write failing tests**

Create `tests/core/turn-broker-acp.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TurnBroker } from "../../src/core/turn-broker.js";
import { SessionStore } from "../../src/core/session-store.js";

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "turn-broker-acp-"));
  const sessionStore = new SessionStore(root);
  await sessionStore.createSession("s", "step", { id: "sid" });
  return { root, sessionStore };
}

test("TurnBroker persists SessionUpdate-shape events as event:'session_update'", async () => {
  const { sessionStore } = await setup();
  const events = [];
  const fakeRunner = {
    async run({ prompt }) {
      // Emit two SessionUpdates back through onEvent (set on construction).
      // Caller wires onEvent into runnerFactory below.
      this._onEvent({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } });
      this._onEvent({
        sessionUpdate: "tool_call",
        toolCallId: "tc1", title: "Read", kind: "read", status: "in_progress", rawInput: {}
      });
      this._onEvent({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" } });
      return { exitCode: 0, result: { type: "result", subtype: "success", result: "" }, claudeSessionId: null };
    },
    cancel() {}
  };
  const runnerFactory = ({ onEvent }) => { fakeRunner._onEvent = onEvent; return fakeRunner; };
  const broker = new TurnBroker({ sessionStore, runnerFactory });
  await broker.startTurn({ slug: "s", stepId: "step", sid: "sid", prompt: "go", cwd: "/tmp" });

  // Wait for turn to complete by polling sessionStore for the assistant_message.
  for (let i = 0; i < 50 && !events.length; i++) {
    const all = await sessionStore.listEvents("s", "step", "sid");
    if (all.find((e) => e.event === "assistant_message")) { events.push(...all); break; }
    await new Promise((r) => setTimeout(r, 20));
  }
  const updates = events.filter((e) => e.event === "session_update");
  assert.equal(updates.length, 3);
  assert.equal(updates[0].data.sessionUpdate, "agent_message_chunk");
  assert.equal(updates[1].data.sessionUpdate, "tool_call");

  const assistantMsg = events.find((e) => e.event === "assistant_message");
  assert.match(assistantMsg.data.content, /Hello/);
  assert.match(assistantMsg.data.content, / world/);
});
```

If `SessionStore` lacks `listEvents`/`createSession`, look at the existing API and use whatever is the right method (the test author should investigate `src/core/session-store.js` and use the actual method names). The test's job is to assert: (a) every runner-emitted event is persisted under `event: "session_update"` with the SessionUpdate as `data`, (b) assistantText is correctly assembled across `agent_message_chunk` updates.

**Step 2: Run — expect FAIL** (likely the `event: "claude"` write rather than `"session_update"`).

**Step 3: Implement**

In [src/core/turn-broker.js](src/core/turn-broker.js):

1. Replace the `onEvent` body at lines 83–100 with the SessionUpdate walker shown above.
2. Replace `await append("claude", claudeEvent)` with `await append("session_update", update)`.
3. **Important**: `toolUses` array currently captures `{ name: block.name, input: block.input }`. For ACP the equivalent is `{ name: update.title, input: update.rawInput }`. Update accordingly.

**Step 4: Run — expect PASS**

Run: `node --test tests/core/turn-broker-acp.test.js`

**Step 5: Adjust existing tests**

Run `pnpm test` and fix any tests that asserted on `event: "claude"` or claude-shape stream events from TurnBroker. Search:

```bash
grep -rn '"claude"\|event.*claude\|assistantText.*content' tests/ | grep -v node_modules
```

Update each to assert on `"session_update"` and SessionUpdate shape.

**Step 6: Commit**

```bash
git add src/core/turn-broker.js tests/core/turn-broker-acp.test.js tests/   # plus any updated tests
git commit -m "feat(turn-broker): persist runner output as ACP SessionUpdate (event:'session_update')"
```

---

### Task 1.2: Wire ClaudeCodeRunner output through the adapter

**Files:**
- Modify: [src/runners/claude-code.js](src/runners/claude-code.js) — wrap `onEvent` calls
- Modify: any test that asserts on the runner's onEvent payload shape

**Step 1: Write failing test**

Create `tests/runners/claude-code-acp.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeCodeRunner } from "../../src/runners/claude-code.js";

// We don't have a real `claude` binary in CI. Use a tiny stub that emits stream-json on stdout.
test("ClaudeCodeRunner emits SessionUpdate shapes (not claude stream-json) via onEvent", async () => {
  const events = [];
  const onEvent = (e) => events.push(e);

  // Stub binary: prints two stream-json lines then exits.
  const runner = new ClaudeCodeRunner({
    binary: "node",
    cwd: process.cwd(),
    onEvent,
    // override the spawn args via a dedicated injection seam (add one if missing — see implementation below)
  });

  // Quickest path: replace runner.binary args and stdin to inject a stub script.
  // If claude-code.js doesn't allow easy injection, the implementer should add a small commandRunner-style hook.
  // For this test we use a stub script via a separate fixture.
  const result = await runner.run({ prompt: "hello" });
  assert.equal(result.exitCode, 0);
  // Every onEvent payload must be an ACP SessionUpdate (has .sessionUpdate field), NOT a claude stream-json event.
  for (const e of events) {
    assert.ok(typeof e.sessionUpdate === "string", `expected SessionUpdate, got ${JSON.stringify(e)}`);
  }
});
```

Note: this test needs a stub for the `claude` binary. The implementer should:
- Either add `tests/fixtures/claude-stream-stub.js` that prints stream-json on stdout and exits, then `binary: "node", args: [stub]` in the test.
- Or inject via `commandRunner`-style hook if claude-code.js doesn't allow direct stub injection.

**Step 2: Run — expect FAIL** (current ClaudeCodeRunner emits raw stream-json events).

**Step 3: Implement**

In [src/runners/claude-code.js:110](src/runners/claude-code.js#L110) (or wherever the parsed event is currently handed to `onEvent`):

```js
import { translateStreamEvent } from "./claude-stream-to-acp.js";

// ...inside the parsed-line handler:
for (const update of translateStreamEvent(parsedEvent)) {
  this.onEvent?.(update);
}
```

Do NOT call `this.onEvent?.(parsedEvent)` directly anymore. The raw stream-json must NEVER leave this file.

The `claudeSessionId` extraction (currently from `system`/`result` events) stays — that's runner-internal metadata, not part of the event stream.

**Step 4: Run — expect PASS**

**Step 5: Update consumers** — if any other code or test consumed `onEvent` with raw stream-json shape, update to SessionUpdate shape.

**Step 6: Commit**

```bash
git add src/runners/claude-code.js tests/runners/claude-code-acp.test.js tests/fixtures/claude-stream-stub.js
git commit -m "feat(claude-code): translate stream-json to SessionUpdate at the runner boundary"
```

---

### Task 1.3: Wire HermesStreamingRunner output through the adapter

Same pattern as 1.2 for [src/runners/hermes-streaming.js:67-76](src/runners/hermes-streaming.js#L67-L76).

**Files:**
- Modify: `src/runners/hermes-streaming.js`
- Modify: tests under `tests/` that assert hermes-shape events

**Step 1: Write failing test**

```js
// tests/runners/hermes-streaming-acp.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { HermesStreamingRunner } from "../../src/runners/hermes-streaming.js";

test("HermesStreamingRunner emits SessionUpdate shapes via onEvent", async () => {
  const events = [];
  // Use `node` with a heredoc-style script that just prints two lines on stdout.
  // The runner reads stdout line-by-line and translates.
  const runner = new HermesStreamingRunner({
    binary: "node",
    cwd: process.cwd(),
    onEvent: (e) => events.push(e)
  });
  // Inject prompt; the binary echoes "hello\nworld\n" via a small inline script.
  // (Implementer: if HermesStreamingRunner doesn't allow easy binary injection,
  //  add one or use a fixture script.)
  // ... pseudo-impl: spawn with `node -e "console.log('hello'); console.log('world');"` ...
  // Assert every event has .sessionUpdate
  // (See actual test for the real spawn path.)
});
```

**Step 2: Run — expect FAIL**

**Step 3: Implement**

In `src/runners/hermes-streaming.js:67-76`, the `emitText` helper currently emits:
```js
this.onEvent?.({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] }
});
```

Replace with:
```js
import { translateStreamEvent } from "./claude-stream-to-acp.js";

const emitText = (text) => {
  for (const update of translateStreamEvent({
    type: "assistant",
    message: { content: [{ type: "text", text }] }
  })) {
    try { this.onEvent?.(update); } catch { /* ignore */ }
  }
};
```

**Step 4: Run — expect PASS**

**Step 5: Commit**

```bash
git add src/runners/hermes-streaming.js tests/runners/hermes-streaming-acp.test.js
git commit -m "feat(hermes-streaming): emit ACP SessionUpdate via shared adapter"
```

---

### Task 1.4: Update SSE turn endpoints to forward SessionUpdate

**Files:**
- Modify: [server/api/projects/[slug]/steps/[stepId]/sessions/[sid]/turn/stream.get.ts](server/api/projects/[slug]/steps/[stepId]/sessions/[sid]/turn/stream.get.ts)
- Modify: [server/api/projects/[slug]/steps/[stepId]/sessions/[sid]/turn.post.ts](server/api/projects/[slug]/steps/[stepId]/sessions/[sid]/turn.post.ts) — emits same event names

**Background:** stream.get.ts:69 emits `event: entry.event` directly. Since TurnBroker now persists `event: "session_update"` (instead of `"claude"`), the SSE event name auto-flips. No code change needed there.

But:
1. The terminal-state check at [stream.get.ts:86](server/api/projects/[slug]/steps/[stepId]/sessions/[sid]/turn/stream.get.ts#L86) uses `entry.event === "done" || entry.event === "turn_failed"` — keep, both still emitted.
2. `turn.post.ts` may emit hardcoded `event: "claude"` somewhere — search and update.

**Step 1: Investigate**

```bash
grep -n '"claude"\|event.*claude' server/api/projects/'[slug]'/steps/ -r
```

Inventory every hardcoded `claude` SSE name.

**Step 2: Update**

Where the SSE event is hardcoded `"claude"`, replace with `"session_update"`. Search/replace in the listed files only.

**Step 3: Run integration tests**

Run: `pnpm test`. Existing turn-flow tests may break — fix until green.

**Step 4: Commit**

```bash
git add server/api/projects/'[slug]'/steps/'[stepId]'/sessions/'[sid]'/turn.post.ts server/api/projects/'[slug]'/steps/'[stepId]'/sessions/'[sid]'/turn/stream.get.ts
git commit -m "feat(api): forward TurnBroker SessionUpdate as SSE event:'session_update'"
```

---

### Task 1.5: Update UI consumers (ChatStream.vue and friends)

**Files:**
- Modify: [app/components/ChatStream.vue](app/components/ChatStream.vue) — listens for `claude`/`assistant_message`/`session_reset`/`turn_failed` SSE events
- Modify: [app/components/RunTaskDetail.vue](app/components/RunTaskDetail.vue) — has `kind: "tool_use"` in its types; align with ACP shape
- Possibly: [app/lib/types.ts](app/lib/types.ts)

**Step 1: Read consumers**

```bash
grep -rn 'addEventListener\|tool_use\|tool_result\|"claude"' app/ | grep -v node_modules
```

For each: understand what part of the data shape it relies on. Common patterns:
- `es.addEventListener("claude", ev => { const data = JSON.parse(ev.data); ...walk data.message.content[]... })` — needs to become: listen for `session_update`, walk `data.sessionUpdate === "agent_message_chunk" | "tool_call" | "tool_call_update"`.

**Step 2: Update [app/components/ChatStream.vue](app/components/ChatStream.vue)**

Replace the `claude` listener at line 189 with a `session_update` listener. The body should switch on `data.sessionUpdate`:

```ts
es.addEventListener("session_update", (ev: MessageEvent) => {
  const update = JSON.parse(ev.data).data; // server wraps as { seq, data: <SessionUpdate> }
  if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
    appendAssistantText(update.content.text);
  } else if (update.sessionUpdate === "tool_call") {
    pushToolCall({ id: update.toolCallId, name: update.title, kind: update.kind, input: update.rawInput });
  } else if (update.sessionUpdate === "tool_call_update") {
    completeToolCall(update.toolCallId, update.status);
  } else if (update.sessionUpdate === "plan") {
    appendPlan(update.entries);
  }
  // ignore unknown sessionUpdate kinds
});
```

The existing `assistant_message`, `session_reset`, `turn_failed` listeners stay — they consume TurnBroker's bookkeeping events, which keep their names.

**Step 3: Update [app/components/RunTaskDetail.vue](app/components/RunTaskDetail.vue)**

The `kind` enum at line 9 includes `"tool_use"`. Rename to `"tool_call"` for consistency with ACP. Update the template at line 116. Update wherever this component receives entries.

**Step 4: Verify in browser**

This is a UI change. Per CLAUDE.md: start dev server, run a turn, verify chunks stream, tool calls render, completion shows. Document any visual regressions.

```bash
pnpm dev
# In another terminal: trigger a turn against an existing slug. Watch the network tab for SSE events.
```

**Step 5: Commit**

```bash
git add app/components/ChatStream.vue app/components/RunTaskDetail.vue app/lib/types.ts
git commit -m "feat(ui): consume ACP SessionUpdate over SSE; drop claude-stream-json shape"
```

---

## Phase 2 — ACP Client Runner (input side)

### Task 2.1: AcpRunner — identity passthrough

specifyr can now drive any ACP-speaking agent.

**Files:**
- Create: `src/runners/acp.js`
- Create: `tests/runners/acp-runner.test.js`

**Step 1: Write the failing test**

```js
// tests/runners/acp-runner.test.js
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
  // Default stub script emits exactly one update.
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
```

**Step 2: Run — expect FAIL**

**Step 3: Implement**

```js
// src/runners/acp.js
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

/**
 * Speak ACP to a child agent over stdio. Forwards `session/update` notifications
 * verbatim through onEvent — TurnBroker handles them as native ACP shapes.
 *
 * Drop-in compatible with the `{ run, cancel }` shape that TurnBroker
 * (turn-broker.js:104) and RunScheduler (run-scheduler.js:64) expect.
 */
export class AcpRunner {
  constructor({ binary, args = [], cwd = process.cwd(), env, memoryRoot, onEvent, approvalService, slug, agent } = {}) {
    if (!binary) throw new Error("AcpRunner: binary is required");
    this.binary = binary;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.memoryRoot = memoryRoot;
    this.onEvent = onEvent;
    this.approvalService = approvalService;
    this.slug = slug;
    this.agent = agent;
    this.child = null;
  }

  async run({ prompt, signal } = {}) {
    if (!prompt?.trim()) throw new Error("AcpRunner: prompt must be non-empty");

    const child = spawn(this.binary, this.args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        ...(this.memoryRoot ? { HERMES_HOME: this.memoryRoot } : {}),
        ...(this.env ?? {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { stderr += c; });

    const onEvent = this.onEvent;
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout)
    );

    const conn = new ClientSideConnection(
      () => ({
        async sessionUpdate({ update }) {
          // Identity: TurnBroker speaks ACP natively — no translation here.
          onEvent?.(update);
        },
        async requestPermission(req) {
          // Filled in Task 2.3 — for now safe-deny.
          const reject = req.options.find((o) => o.optionId === "reject_once") ?? req.options[0];
          return { outcome: { outcome: "selected", optionId: reject.optionId } };
        },
        async readTextFile() { throw new Error("fs/read_text_file not implemented yet (Task 2.2)"); },
        async writeTextFile() { throw new Error("fs/write_text_file not implemented yet (Task 2.2)"); }
      }),
      stream
    );

    const onAbort = () => { if (this.child && !this.child.killed) this.child.kill("SIGTERM"); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      await conn.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }
      });
      const newSession = await conn.newSession({ cwd: this.cwd, mcpServers: [] });
      const promptResult = await conn.prompt({
        sessionId: newSession.sessionId,
        prompt: [{ type: "text", text: prompt }]
      });
      child.kill();
      return {
        claudeSessionId: null,
        result: {
          type: "result",
          subtype: promptResult.stopReason === "end_turn" ? "success" : "error",
          result: ""
        },
        exitCode: 0,
        stderr
      };
    } catch (err) {
      if (signal?.aborted) {
        const e = new Error("Aborted");
        e.aborted = true;
        throw e;
      }
      throw err;
    } finally {
      this.child = null;
    }
  }

  cancel() {
    if (this.child && !this.child.killed) this.child.kill("SIGTERM");
  }
}
```

**Step 4: Run — expect PASS**

**Step 5: Commit**

```bash
git add src/runners/acp.js tests/runners/acp-runner.test.js
git commit -m "feat(acp): AcpRunner — pass-through SessionUpdates from any ACP agent"
```

---

### Task 2.2: fs/read_text_file + fs/write_text_file handlers

Same as the original plan's Task 1.4. Cwd-scoped, refuses path-traversal.

**Files:**
- Create: `src/acp/fs-handlers.js`
- Create: `tests/acp/fs-handlers.test.js`
- Modify: `src/runners/acp.js` — wire into ClientSideConnection

**Step 1: Write the failing tests**

```js
// tests/acp/fs-handlers.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeFsHandlers } from "../../src/acp/fs-handlers.js";

async function tempProject() {
  const root = await mkdtemp(path.join(tmpdir(), "acp-fs-"));
  await writeFile(path.join(root, "hello.txt"), "world");
  return root;
}

test("read inside cwd", async () => {
  const root = await tempProject();
  const fs = makeFsHandlers({ cwd: root });
  const r = await fs.readTextFile({ path: path.join(root, "hello.txt") });
  assert.equal(r.content, "world");
});

test("read rejects path outside cwd", async () => {
  const root = await tempProject();
  const fs = makeFsHandlers({ cwd: root });
  await assert.rejects(fs.readTextFile({ path: "/etc/passwd" }), /outside/);
});

test("read rejects relative paths", async () => {
  const root = await tempProject();
  const fs = makeFsHandlers({ cwd: root });
  await assert.rejects(fs.readTextFile({ path: "hello.txt" }), /absolute/);
});

test("write inside cwd creates file", async () => {
  const root = await tempProject();
  const fs = makeFsHandlers({ cwd: root });
  await fs.writeTextFile({ path: path.join(root, "out.txt"), content: "data" });
  assert.equal(await readFile(path.join(root, "out.txt"), "utf8"), "data");
});

test("write rejects outside cwd", async () => {
  const root = await tempProject();
  const fs = makeFsHandlers({ cwd: root });
  await assert.rejects(fs.writeTextFile({ path: "/tmp/escape", content: "x" }), /outside/);
});

test("read with line+limit slice", async () => {
  const root = await tempProject();
  const fs = makeFsHandlers({ cwd: root });
  const file = path.join(root, "multi.txt");
  await writeFile(file, "a\nb\nc\nd\ne\n");
  const r = await fs.readTextFile({ path: file, line: 2, limit: 2 });
  assert.equal(r.content, "b\nc");
});
```

**Step 2: Run — expect FAIL**

**Step 3: Implement**

```js
// src/acp/fs-handlers.js
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";

export function makeFsHandlers({ cwd }) {
  if (!cwd || !path.isAbsolute(cwd)) {
    throw new Error("makeFsHandlers: absolute cwd required");
  }
  const root = path.resolve(cwd);

  function check(p) {
    if (typeof p !== "string" || p.length === 0) throw new Error("path required");
    if (!path.isAbsolute(p)) throw new Error("path must be absolute");
    const resolved = path.resolve(p);
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`path outside session cwd: ${resolved}`);
    }
    return resolved;
  }

  return {
    async readTextFile({ path: p, line, limit }) {
      const safe = check(p);
      const content = await readFile(safe, "utf8");
      if (line == null && limit == null) return { content };
      const lines = content.split("\n");
      const startIdx = Math.max(0, (line ?? 1) - 1);
      const sliced = limit != null ? lines.slice(startIdx, startIdx + limit) : lines.slice(startIdx);
      return { content: sliced.join("\n") };
    },
    async writeTextFile({ path: p, content }) {
      const safe = check(p);
      await mkdir(path.dirname(safe), { recursive: true });
      await writeFile(safe, content, "utf8");
      return {};
    }
  };
}
```

**Step 4: Run — expect PASS**

**Step 5: Wire into AcpRunner**

In `src/runners/acp.js`, top of `run()`:

```js
import { makeFsHandlers } from "../acp/fs-handlers.js";
// ...
const fs = makeFsHandlers({ cwd: this.cwd });
```

Replace the throwing stubs in the `ClientSideConnection` callbacks:

```js
async readTextFile(req) { return fs.readTextFile(req); },
async writeTextFile(req) { return fs.writeTextFile(req); }
```

**Step 6: Commit**

```bash
git add src/acp/fs-handlers.js tests/acp/fs-handlers.test.js src/runners/acp.js
git commit -m "feat(acp): cwd-scoped fs/read_text_file and fs/write_text_file"
```

---

### Task 2.3: session/request_permission → CapabilityApprovalService

**Files:**
- Create: `src/acp/permission-bridge.js`
- Create: `tests/acp/permission-bridge.test.js`
- Modify: `src/runners/acp.js` — replace safe-deny stub with bridge

**Step 1: Write tests**

```js
// tests/acp/permission-bridge.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { acpPermissionToCapability, capabilityDecisionToAcpOutcome } from "../../src/acp/permission-bridge.js";

test("maps Edit/Write to filesystem:write", () => {
  assert.equal(acpPermissionToCapability({ title: "Edit" }), "filesystem:write");
  assert.equal(acpPermissionToCapability({ title: "Write" }), "filesystem:write");
});

test("maps Bash to shell:execute", () => {
  assert.equal(acpPermissionToCapability({ title: "Bash" }), "shell:execute");
});

test("maps Read to filesystem:read", () => {
  assert.equal(acpPermissionToCapability({ title: "Read" }), "filesystem:read");
});

test("approve decision becomes allow_once", () => {
  const o = capabilityDecisionToAcpOutcome("approved", [
    { optionId: "allow_once" }, { optionId: "reject_once" }
  ]);
  assert.equal(o.outcome, "selected");
  assert.equal(o.optionId, "allow_once");
});

test("deny decision becomes reject_once", () => {
  const o = capabilityDecisionToAcpOutcome("denied", [
    { optionId: "allow_once" }, { optionId: "reject_once" }
  ]);
  assert.equal(o.optionId, "reject_once");
});
```

**Step 2: Run — expect FAIL**

**Step 3: Implement**

```js
// src/acp/permission-bridge.js
const TITLE_TO_CAP = {
  Edit: "filesystem:write",
  Write: "filesystem:write",
  MultiEdit: "filesystem:write",
  Read: "filesystem:read",
  Glob: "filesystem:read",
  Grep: "filesystem:read",
  Bash: "shell:execute",
  WebFetch: "network:http",
  WebSearch: "network:http"
};

export function acpPermissionToCapability({ title }) {
  return TITLE_TO_CAP[title] ?? `tool:${String(title ?? "unknown").toLowerCase()}`;
}

export function capabilityDecisionToAcpOutcome(decision, options) {
  const want = decision === "approved" ? "allow_once" : "reject_once";
  const match = options.find((o) => o.optionId === want) ?? options[0];
  return { outcome: "selected", optionId: match.optionId };
}
```

**Step 4: Wire into AcpRunner**

In `src/runners/acp.js`, replace the `requestPermission` stub:

```js
async requestPermission({ sessionId, toolCall, options }) {
  if (!this.approvalService || !this.agent) {
    const reject = options.find((o) => o.optionId === "reject_once") ?? options[0];
    return { outcome: { outcome: "selected", optionId: reject.optionId } };
  }
  const capability = acpPermissionToCapability({ title: toolCall.title });
  const decision = await this.approvalService.requestApproval({
    slug: this.slug,
    agent: this.agent,
    capability,
    requestPayload: { toolCall, sessionId }
  });
  return { outcome: capabilityDecisionToAcpOutcome(decision, options) };
}
```

(Bind `this` correctly — capture before passing into the SDK callback object.)

**Step 5: Run — expect PASS**

**Step 6: Commit**

```bash
git add src/acp/permission-bridge.js tests/acp/permission-bridge.test.js src/runners/acp.js
git commit -m "feat(acp): bridge session/request_permission to CapabilityApprovalService"
```

---

### Task 2.4: Wire AcpRunner into RunScheduler

**Files:**
- Modify: [src/core/run-scheduler.js](src/core/run-scheduler.js#L52-L83) (`pickRunner`)
- Modify: [src/core/app-config.js](src/core/app-config.js#L8-L11) — add `acp.<name>` block
- Create: `tests/runners/acp-runner-scheduler.test.js`

**Step 1: Test**

```js
// tests/runners/acp-runner-scheduler.test.js
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunScheduler } from "../../src/core/run-scheduler.js";

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
  const runner = await sched.pickRunner();
  assert.ok(runner, "expected a runner");
  assert.equal(sched._runnerName, "acp:stub");
});
```

**Step 2: Run — expect FAIL**

**Step 3: Update default config**

In [src/core/app-config.js](src/core/app-config.js):

```js
const DEFAULT_APP_CONFIG = {
  standardExtensions: ["superpowers-bridge"],
  localExtensions: [],
  runner: {
    default: "hermes",
    fallbackChain: ["acp:gemini", "hermes", "superpowers", "claude"]
  },
  claude: { binary: "claude" },
  hermes: { binary: "hermes" },
  acp: {
    gemini: { binary: "gemini", args: ["--experimental-acp"] }
  }
};
```

Plus extend the merge in `loadAppConfig`:
```js
acp: { ...DEFAULT_APP_CONFIG.acp, ...(saved.acp ?? {}) }
```

**Step 4: Update pickRunner**

In [src/core/run-scheduler.js](src/core/run-scheduler.js#L52-L83):

```js
import { AcpRunner } from "../runners/acp.js";

// inside pickRunner — add acp branch BEFORE the existing hermes/claude branches:
for (const name of chain) {
  if (name.startsWith("acp:")) {
    const acpKey = name.slice("acp:".length);
    const cfg = this.appConfig?.acp?.[acpKey];
    if (!cfg?.binary) continue;
    this._runnerName = `acp:${acpKey}`;
    return ({ cwd, onEvent }) =>
      new AcpRunner({
        binary: cfg.binary,
        args: cfg.args ?? [],
        cwd,
        onEvent,
        memoryRoot: path.join(this.projectCwd, ".specifyr", this.slug, "agent-memory")
      });
  }
  // existing hermes/claude branches...
}
```

(Adapt to whatever exact pattern `pickRunner` uses today.)

**Step 5: Run — expect PASS**

Run: `node --test tests/runners/acp-runner-scheduler.test.js`

**Step 6: Verify the existing test suite still passes**

Run: `pnpm test`

**Step 7: Commit**

```bash
git add src/core/run-scheduler.js src/core/app-config.js tests/runners/acp-runner-scheduler.test.js
git commit -m "feat(acp): wire AcpRunner into RunScheduler fallback chain"
```

---

### Task 2.5: Integration test against gemini-cli (skip-if-missing)

**Files:**
- Create: `tests/integration/acp-gemini.test.js`

```js
import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { AcpRunner } from "../../src/runners/acp.js";

function hasGemini() {
  try { execSync("gemini --version", { stdio: "ignore" }); return true; } catch { return false; }
}

test("gemini-cli end-to-end via ACP", { skip: !hasGemini() }, async () => {
  const events = [];
  const runner = new AcpRunner({
    binary: "gemini",
    args: ["--experimental-acp"],
    cwd: process.cwd(),
    onEvent: (e) => events.push(e)
  });
  const r = await runner.run({ prompt: "Reply with the single word OK and nothing else." });
  assert.equal(r.exitCode, 0);
  const text = events
    .filter((e) => e.sessionUpdate === "agent_message_chunk")
    .map((e) => e.content?.text ?? "")
    .join("");
  assert.match(text, /OK/i);
});
```

Run: `node --test tests/integration/acp-gemini.test.js`
Expected: PASS if gemini installed; SKIPPED otherwise.

```bash
git add tests/integration/acp-gemini.test.js
git commit -m "test(acp): integration smoke test against gemini-cli (skip-if-missing)"
```

---

## Phase 3 — ACP Server Adapter (output side)

specifyr exposes its runs over an HTTP+SSE API today. This phase adds a stdio binary that speaks ACP, so editors like Zed and AionUi can spawn `specifyr-acp` and drive runs.

### Task 3.1: stdio entrypoint scaffold

**Files:**
- Create: `bin/specifyr-acp.js`
- Create: `src/acp/server.js`
- Create: `tests/acp/server-handshake.test.js`
- Modify: `package.json` — add to `bin` map

**Step 1: Write the failing test**

```js
// tests/acp/server-handshake.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "..", "bin", "specifyr-acp.js");

test("server responds to initialize with protocolVersion=1", async () => {
  const p = spawn("node", [BIN], { stdio: ["pipe", "pipe", "inherit"] });
  const req = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {} }
  }) + "\n";
  p.stdin.write(req);
  const res = await new Promise((resolve) => {
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += String(d);
      const nl = buf.indexOf("\n");
      if (nl >= 0) resolve(JSON.parse(buf.slice(0, nl)));
    });
  });
  p.kill();
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, 1);
  assert.equal(res.result.agentCapabilities.loadSession, true);
});
```

**Step 2: Run — expect FAIL**

**Step 3: Implement entrypoint**

```js
#!/usr/bin/env node
// bin/specifyr-acp.js
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { createSpecifyrAcpAgent } from "../src/acp/server.js";

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin)
);

new AgentSideConnection(
  (client) => createSpecifyrAcpAgent({ client, projectRoot: process.cwd() }),
  stream
);
```

```js
// src/acp/server.js
export function createSpecifyrAcpAgent(/* { client, projectRoot, turnBroker, approvalService } */) {
  return {
    async initialize() {
      return {
        protocolVersion: 1,
        agentInfo: { name: "specifyr", version: "0.1.0" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { embeddedContext: true, image: false, audio: false },
          mcpCapabilities: { http: false, sse: false }
        },
        authMethods: []
      };
    },
    async authenticate() { return null; },
    async newSession() { throw new Error("session/new not implemented"); },
    async loadSession() { throw new Error("session/load not implemented"); },
    async prompt() { throw new Error("session/prompt not implemented"); },
    async cancel() {}
  };
}
```

Add to `package.json`:
```json
"bin": {
  "specifyr": "./src/index.js",
  "specifyr-acp": "./bin/specifyr-acp.js"
}
```

`chmod +x bin/specifyr-acp.js`

**Step 4: Run — expect PASS**

**Step 5: Commit**

```bash
chmod +x bin/specifyr-acp.js
git add bin/specifyr-acp.js src/acp/server.js package.json tests/acp/server-handshake.test.js
git commit -m "feat(acp): specifyr-acp stdio entrypoint with initialize handshake"
```

---

### Task 3.2: session/new — resolve slug from cwd, create session record

**Files:**
- Modify: `src/acp/server.js`
- Create: `tests/acp/server-new-session.test.js`

**Step 1: Test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSpecifyrAcpAgent } from "../../src/acp/server.js";

async function projectWithSlug(slug = "demo") {
  const root = await mkdtemp(path.join(tmpdir(), "specifyr-acp-"));
  await mkdir(path.join(root, ".specifyr", slug, "steps"), { recursive: true });
  await writeFile(path.join(root, ".specifyr", slug, "meta.json"), JSON.stringify({ slug, title: "demo" }));
  return { root, slug };
}

test("session/new with cwd inside a slug returns an encoded sessionId", async () => {
  const { root, slug } = await projectWithSlug();
  const agent = createSpecifyrAcpAgent({ client: { sessionUpdate: async () => {} }, projectRoot: root });
  const r = await agent.newSession({ cwd: root, mcpServers: [] });
  assert.match(r.sessionId, new RegExp(`^specifyr:1:${slug}:`));
});

test("session/new with cwd in unknown project rejects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "specifyr-acp-"));
  const agent = createSpecifyrAcpAgent({ client: {}, projectRoot: root });
  await assert.rejects(agent.newSession({ cwd: root, mcpServers: [] }), /no specifyr project/i);
});
```

**Step 2: Implement**

```js
// extend src/acp/server.js
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { encodeSessionId } from "./session-id.js";

async function resolveSlugFromCwd(projectRoot, cwd) {
  const root = path.resolve(projectRoot);
  const dir = path.join(root, ".specifyr");
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { throw new Error(`no specifyr project at ${root}`); }
  const slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  if (slugs.length === 0) throw new Error(`no specifyr project at ${root}`);
  const cwdResolved = path.resolve(cwd);
  const match = slugs.find((s) => cwdResolved.startsWith(path.join(dir, s)));
  if (match) return match;
  if (slugs.length === 1) return slugs[0];
  throw new Error(`ambiguous slug: cwd ${cwd} matches none of ${slugs.join(", ")}`);
}

export function createSpecifyrAcpAgent({ client, projectRoot, turnBroker, approvalService }) {
  return {
    async initialize() { /* unchanged */ },
    async authenticate() { return null; },
    async newSession({ cwd }) {
      const slug = await resolveSlugFromCwd(projectRoot, cwd);
      const stepId = "ad-hoc";
      const sid = `acp-${randomUUID().slice(0, 8)}`;
      const stepsDir = path.join(projectRoot, ".specifyr", slug, "steps", stepId, "sessions");
      await fs.mkdir(stepsDir, { recursive: true });
      await fs.writeFile(
        path.join(stepsDir, `${sid}.json`),
        JSON.stringify({ id: sid, status: "idle", title: "ACP session", createdAt: new Date().toISOString() }, null, 2)
      );
      return { sessionId: encodeSessionId({ slug, stepId, sid }) };
    },
    async loadSession() { throw new Error("session/load not implemented"); },
    async prompt() { throw new Error("session/prompt not implemented"); },
    async cancel() {}
  };
}
```

**Step 3: Verify, commit**

```bash
git add src/acp/server.js tests/acp/server-new-session.test.js
git commit -m "feat(acp): session/new resolves slug from cwd"
```

---

### Task 3.3: session/load — restore an existing session

**Files:**
- Modify: `src/acp/server.js`
- Create: `tests/acp/server-load-session.test.js`

**Step 1: Test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSpecifyrAcpAgent } from "../../src/acp/server.js";
import { encodeSessionId } from "../../src/acp/session-id.js";

test("session/load returns ok for an existing session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "specifyr-acp-"));
  const slug = "demo", stepId = "step-1", sid = "s1";
  const dir = path.join(root, ".specifyr", slug, "steps", stepId, "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${sid}.json`), JSON.stringify({ id: sid, status: "completed" }));
  const agent = createSpecifyrAcpAgent({ client: {}, projectRoot: root });
  const r = await agent.loadSession({
    sessionId: encodeSessionId({ slug, stepId, sid }), cwd: root, mcpServers: []
  });
  assert.deepEqual(r, {});
});

test("session/load on missing session rejects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "specifyr-acp-"));
  const agent = createSpecifyrAcpAgent({ client: {}, projectRoot: root });
  await assert.rejects(
    agent.loadSession({ sessionId: encodeSessionId({ slug: "x", stepId: "y", sid: "z" }), cwd: root, mcpServers: [] }),
    /not found/i
  );
});
```

**Step 2: Implement**

```js
// in src/acp/server.js
import { decodeSessionId } from "./session-id.js";

// inside agent object:
async loadSession({ sessionId }) {
  const { slug, stepId, sid } = decodeSessionId(sessionId);
  const file = path.join(projectRoot, ".specifyr", slug, "steps", stepId, "sessions", `${sid}.json`);
  try { await fs.access(file); }
  catch { throw new Error(`session not found: ${sessionId}`); }
  return {};
}
```

**Step 3: Commit**

```bash
git add src/acp/server.js tests/acp/server-load-session.test.js
git commit -m "feat(acp): session/load validates existence of persisted session"
```

---

### Task 3.4: session/prompt — bridge TurnBroker → session/update

This is dramatically simpler now: TurnBroker already persists ACP-shape events, so the prompt handler reads them and forwards verbatim.

**Files:**
- Modify: `src/acp/server.js`
- Create: `tests/acp/server-prompt.test.js`

**Step 1: Test**

```js
// tests/acp/server-prompt.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSpecifyrAcpAgent } from "../../src/acp/server.js";
import { encodeSessionId } from "../../src/acp/session-id.js";

class FakeBroker {
  constructor() { this.emitters = new Map(); }
  emitterFor(slug, stepId, sid) {
    const k = `${slug}|${stepId}|${sid}`;
    if (!this.emitters.has(k)) this.emitters.set(k, new EventEmitter());
    return this.emitters.get(k);
  }
  async startTurn({ slug, stepId, sid }) {
    const e = this.emitterFor(slug, stepId, sid);
    setImmediate(() => {
      e.emit("event", {
        event: "session_update",
        data: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }
      });
      e.emit("event", { event: "done", data: {} });
      e.emit("ended");
    });
    return { startSeq: 0 };
  }
  cancel() {}
}

test("prompt forwards SessionUpdate verbatim and resolves end_turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "specifyr-acp-"));
  const slug = "demo", stepId = "s", sid = "x";
  await mkdir(path.join(root, ".specifyr", slug, "steps", stepId, "sessions"), { recursive: true });
  await writeFile(path.join(root, ".specifyr", slug, "steps", stepId, "sessions", `${sid}.json`), "{}");

  const updates = [];
  const fakeClient = { sessionUpdate: async (n) => updates.push(n) };
  const agent = createSpecifyrAcpAgent({
    client: fakeClient,
    projectRoot: root,
    turnBroker: new FakeBroker()
  });

  const r = await agent.prompt({
    sessionId: encodeSessionId({ slug, stepId, sid }),
    prompt: [{ type: "text", text: "hello" }]
  });
  assert.equal(r.stopReason, "end_turn");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].update.sessionUpdate, "agent_message_chunk");
  assert.equal(updates[0].update.content.text, "hi");
});
```

**Step 2: Implement**

```js
// in src/acp/server.js
async prompt({ sessionId, prompt }) {
  const { slug, stepId, sid } = decodeSessionId(sessionId);
  const text = prompt.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const cwd = projectRoot;
  const emitter = turnBroker.emitterFor(slug, stepId, sid);
  let stopReason = "end_turn";

  const done = new Promise((resolve) => {
    const onEvent = async (entry) => {
      if (entry.event === "session_update") {
        try { await client.sessionUpdate({ sessionId, update: entry.data }); }
        catch { /* client gone — TurnBroker still persists */ }
      } else if (entry.event === "turn_failed") {
        stopReason = "refusal";
      }
    };
    const onEnded = () => {
      emitter.off("event", onEvent);
      emitter.off("ended", onEnded);
      resolve();
    };
    emitter.on("event", onEvent);
    emitter.on("ended", onEnded);
  });

  await turnBroker.startTurn({ slug, stepId, sid, prompt: text, cwd });
  await done;
  return { stopReason };
},

async cancel({ sessionId }) {
  const { slug, stepId, sid } = decodeSessionId(sessionId);
  turnBroker.cancel?.(slug, stepId, sid);
}
```

**Step 3: Commit**

```bash
git add src/acp/server.js tests/acp/server-prompt.test.js
git commit -m "feat(acp): session/prompt forwards SessionUpdate verbatim from TurnBroker"
```

---

### Task 3.5: Wire real TurnBroker + RunnerFactory into bin/specifyr-acp

**Files:**
- Modify: `bin/specifyr-acp.js`

Read [server/api/projects/[slug]/steps/[stepId]/sessions/[sid]/turn.post.ts](server/api/projects/[slug]/steps/[stepId]/sessions/[sid]/turn.post.ts) to see how the HTTP endpoint constructs broker + runnerFactory. Mirror that wiring.

```js
// bin/specifyr-acp.js (full)
import { Readable, Writable } from "node:stream";
import path from "node:path";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { createSpecifyrAcpAgent } from "../src/acp/server.js";
import { TurnBroker } from "../src/core/turn-broker.js";
import { SessionStore } from "../src/core/session-store.js";
import { ClaudeCodeRunner } from "../src/runners/claude-code.js";
import { HermesStreamingRunner } from "../src/runners/hermes-streaming.js";
import { AcpRunner } from "../src/runners/acp.js";
import { loadAppConfig } from "../src/core/app-config.js";

const projectRoot = process.cwd();
const appConfig = await loadAppConfig(projectRoot);
const sessionStore = new SessionStore(projectRoot);

function pickRunnerFactory() {
  for (const name of appConfig.runner.fallbackChain) {
    if (name.startsWith("acp:")) {
      const cfg = appConfig.acp?.[name.slice(4)];
      if (cfg?.binary) {
        return ({ cwd, onEvent }) => new AcpRunner({ binary: cfg.binary, args: cfg.args, cwd, onEvent });
      }
    } else if (name === "hermes") {
      return ({ cwd, onEvent }) => new HermesStreamingRunner({ binary: appConfig.hermes.binary, cwd, onEvent });
    } else if (name === "claude") {
      return ({ cwd, onEvent }) => new ClaudeCodeRunner({ binary: appConfig.claude.binary, cwd, onEvent });
    }
  }
  throw new Error("no runner available");
}

const turnBroker = new TurnBroker({ sessionStore, runnerFactory: pickRunnerFactory() });

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin)
);

new AgentSideConnection(
  (client) => createSpecifyrAcpAgent({ client, projectRoot, turnBroker }),
  stream
);
```

**Step 2: Smoke test**

Run inside a real specifyr project:
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' | node bin/specifyr-acp.js
```
Expected: a JSON-RPC response on stdout with `protocolVersion: 1`. Process should not crash on EOF.

**Step 3: Commit**

```bash
git add bin/specifyr-acp.js
git commit -m "feat(acp): wire real TurnBroker + runner factory into stdio entrypoint"
```

---

### Task 3.6: AcpApprovalTransport — bridge approvals to session/request_permission

**Files:**
- Create: `src/acp/approval-transport.js`
- Create: `tests/acp/approval-transport.test.js`
- Modify: `src/acp/server.js` — register transport per session
- Modify: `bin/specifyr-acp.js` — inject `CapabilityApprovalService`

**Step 1: Test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { AcpApprovalTransport } from "../../src/acp/approval-transport.js";

test("transport routes notify() to session/request_permission and resolves approved", async () => {
  const calls = [];
  const fakeClient = {
    requestPermission: async (req) => {
      calls.push(req);
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
    }
  };
  const transport = new AcpApprovalTransport({ client: fakeClient });
  transport.bindSession({ slug: "x" }, "specifyr:1:x:s:y");

  const decision = await transport.notify({
    slug: "x",
    requestId: "r1",
    capability: "filesystem:write",
    requestPayload: { toolCall: { title: "Edit", toolCallId: "tc-1" } }
  });
  assert.equal(decision, "approved");
  assert.equal(calls[0].sessionId, "specifyr:1:x:s:y");
  assert.equal(calls[0].toolCall.toolCallId, "tc-1");
});

test("transport returns 'denied' when no session bound", async () => {
  const transport = new AcpApprovalTransport({ client: { requestPermission: async () => { throw new Error("must not be called"); } } });
  const decision = await transport.notify({
    slug: "x", requestId: "r2", capability: "filesystem:write", requestPayload: {}
  });
  assert.equal(decision, "denied");
});
```

**Step 2: Implement**

```js
// src/acp/approval-transport.js
export class AcpApprovalTransport {
  constructor({ client }) {
    this.client = client;
    this.bindings = new Map();
  }
  bindSession({ slug }, sessionId) { this.bindings.set(slug, sessionId); }
  unbind(slug) { this.bindings.delete(slug); }
  async notify({ slug, capability, requestPayload }) {
    const sessionId = this.bindings.get(slug);
    if (!sessionId) return "denied";
    const toolCall = requestPayload?.toolCall ?? { title: capability, toolCallId: `cap-${Date.now()}` };
    const result = await this.client.requestPermission({
      sessionId,
      toolCall,
      options: [
        { optionId: "allow_once", name: `Allow ${capability} once`, kind: "allow_once" },
        { optionId: "allow_always", name: `Allow ${capability} always`, kind: "allow_always" },
        { optionId: "reject_once", name: "Deny", kind: "reject_once" },
        { optionId: "reject_always", name: "Deny always", kind: "reject_always" }
      ]
    });
    if (result.outcome?.outcome === "selected" && result.outcome.optionId.startsWith("allow")) return "approved";
    return "denied";
  }
}
```

**Step 3: Wire into server.js**

In `createSpecifyrAcpAgent`, accept `approvalService`. Attach a transport when `newSession` runs:

```js
const transport = approvalService ? new AcpApprovalTransport({ client }) : null;
if (transport) approvalService.addTransport(transport);

// in newSession after sessionId is built:
transport?.bindSession({ slug, stepId, sid }, id);
```

(Inspect [src/core/capability-approval-service.js](src/core/capability-approval-service.js) for the actual API name and adapt — assume `addTransport`.)

**Step 4: Wire into bin/specifyr-acp.js**

```js
import { CapabilityApprovalService } from "../src/core/capability-approval-service.js";
import { EventStore } from "../src/core/event-store.js";

const eventStore = new EventStore(path.join(projectRoot, ".specifyr"));
const approvalService = new CapabilityApprovalService({ eventStore });

new AgentSideConnection(
  (client) => createSpecifyrAcpAgent({ client, projectRoot, turnBroker, approvalService }),
  stream
);
```

**Step 5: Verify, commit**

```bash
git add src/acp/approval-transport.js tests/acp/approval-transport.test.js src/acp/server.js bin/specifyr-acp.js
git commit -m "feat(acp): approval transport bridges session/request_permission"
```

---

### Task 3.7: Integration docs for external clients

**Files:**
- Create: `docs/acp-integration.md`

```markdown
# Connecting external ACP clients to specifyr

specifyr ships an ACP server at `bin/specifyr-acp.js`. Any editor/UI that
speaks the Agent Client Protocol can spawn it as a subprocess.

## Zed

Add to `~/.config/zed/settings.json`:

\`\`\`json
{
  "agent_servers": {
    "specifyr": {
      "command": "node",
      "args": ["/absolute/path/to/specifyr/bin/specifyr-acp.js"],
      "cwd": "/absolute/path/to/your/project"
    }
  }
}
\`\`\`

Open Zed's agent panel and pick "specifyr".

## AionUi

In AionUi settings → Custom Agent → add:
- Name: `specifyr`
- Command: `node /absolute/path/to/specifyr/bin/specifyr-acp.js`
- Working directory: your project

Notes:
- The cwd of the spawned process must contain a `.specifyr/` directory.
- Approvals appear in the ACP client's permission UI, not in the Nuxt dashboard.
- Run state is shared: a turn started via ACP shows up in the Nuxt UI's
  history view exactly like a CLI/HTTP-driven turn.
```

```bash
git add docs/acp-integration.md
git commit -m "docs(acp): integration guide for Zed and AionUi"
```

---

## Phase 4 — Cleanup & verify

### Task 4.1: Deprecate or remove HermesCliRunner

The original [src/runners/hermes-cli.js](src/runners/hermes-cli.js) is the *non-streaming* variant — `hermes chat -q` with one-shot stdout capture. With Hermes-streaming + ACP both available, this is redundant.

**Options:**
- Keep but mark `@deprecated` (safe, supports old configs)
- Delete (cleaner — user said no backward compat)

**Decision:** delete. User explicitly said no backward compat.

**Files:**
- Delete: `src/runners/hermes-cli.js`
- Delete: `tests/hermes-cli.test.js`
- Modify: any imports referencing `HermesCliRunner` (e.g. `src/runners/hermes-docker.js`, `src/core/company-runtime.js` if applicable)

**Step 1: Find references**

```bash
grep -rn "hermes-cli\|HermesCliRunner" src/ server/ tests/ | grep -v node_modules
```

For each: replace with HermesStreamingRunner (or AcpRunner if appropriate).

**Step 2: Delete + run tests**

```bash
git rm src/runners/hermes-cli.js tests/hermes-cli.test.js
pnpm test
```

Fix any failures by updating imports.

**Step 3: Commit**

```bash
git commit -m "feat(runners): remove HermesCliRunner — superseded by streaming + ACP"
```

---

### Task 4.2: Update README

**Files:**
- Modify: `README.md`

Add an `## ACP` section after `## Notes`:

```markdown
## ACP

specifyr speaks the [Agent Client Protocol](https://agentclientprotocol.com)
in two directions:

- **As a client** (input): any ACP-speaking coding agent (Gemini CLI,
  hermes-acp, claude-code-acp, …) can be a backend. Configure under
  `runner.fallbackChain` with `acp:<name>` entries plus an `acp.<name>`
  block specifying `binary` and `args`. See `src/core/app-config.js`.

- **As a server** (output): `bin/specifyr-acp` is a stdio agent that
  external editors like Zed and AionUi can spawn to drive specifyr runs.
  See `docs/acp-integration.md`.

Internally specifyr uses ACP `SessionUpdate` shapes as the lingua franca
for all runner output, persisted disk events, and SSE stream payloads.
Old runners (Claude/Hermes stream-json) are translated at the runner
boundary via `src/runners/claude-stream-to-acp.js`.
```

```bash
git add README.md
git commit -m "docs(readme): describe ACP client/server modes and internal lingua franca"
```

---

### Task 4.3: Full-suite verification

**Step 1: Run everything**

```bash
pnpm test
node --test tests/
node bin/specifyr-acp.js < /dev/null   # entrypoint exits cleanly on EOF
```

**Step 2: Type-check**

```bash
pnpm exec vue-tsc --noEmit
```

**Step 3: Manual UI smoke test**

```bash
pnpm dev
```
- Open the Nuxt UI in the browser
- Trigger a turn against an existing slug
- Confirm: streaming chunks render, tool calls render, completion renders
- Confirm history view replay still works

**Step 4: ACP server smoke test (manual, optional)**

If Zed or AionUi is available, configure as in `docs/acp-integration.md` and confirm a turn round-trips end-to-end.

**Step 5: Commit any fixes**

```bash
git commit -m "fix: resolve issues discovered during ACP migration verification"
```

---

## Final verification checklist

Before declaring the migration complete, confirm:

- [ ] `pnpm test` passes (all phases' tests green)
- [ ] `node bin/specifyr-acp.js` accepts `initialize` and replies correctly via `echo` smoke test
- [ ] AcpRunner via `acp:gemini` runs a real turn end-to-end (or `gemini` is unavailable and the integration test correctly skips)
- [ ] At least one external client (Zed or AionUi) successfully drives a turn through `bin/specifyr-acp.js` (record screenshot in `docs/acp-integration.md`)
- [ ] Approval flow round-trips: agent calls a sensitive tool → ACP client shows permission prompt → user clicks allow → tool executes
- [ ] Existing HTTP/SSE turn endpoint still works (regression check via existing turn tests + manual UI smoke test)
- [ ] No `event: "claude"` references remain in code (only in legacy on-disk data, if any)
- [ ] README and `docs/acp-integration.md` updated

---

## Notes for the executing engineer

- **No backward compat layer.** On-disk events written before this migration won't replay correctly in the new UI. That's accepted.
- **SDK API:** `@agentclientprotocol/sdk@0.21.0`. Constructor signature for both `AgentSideConnection` and `ClientSideConnection` is `(toAgent|toClient, stream)` where `stream = { writable, readable }` is a WHATWG-streams pair. Use the SDK's `ndJsonStream(out, in)` helper to build it from Node stdio.
- **TDD discipline:** every task here writes the test first, runs it to see it fail, implements, runs to see it pass, then commits. Don't batch.
- **Out of scope:** spec/plan/task_batch approvals (still specifyr-internal HTTP), multi-tenant approval, remote (HTTP/WS) ACP transport (still WIP upstream), MCP server forwarding inside ACP sessions, full Nuxt rebuild as ACP client.
