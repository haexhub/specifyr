import test from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml } from "yaml";

import {
  validateDispatchBody,
  buildTaskId,
  buildDispatchYaml,
} from "../src/core/mcp-dispatch.js";

// ---------------------------------------------------------------------------
// validateDispatchBody
// ---------------------------------------------------------------------------

const KNOWN = ["ceo", "dev"];

test("validateDispatchBody accepts a well-formed body", () => {
  const r = validateDispatchBody(
    { worker: "dev", task: { goal: "write code" } },
    KNOWN,
  );
  assert.deepEqual(r, { ok: true });
});

test("validateDispatchBody preserves task fields beyond goal (caller passes-through)", () => {
  // The validator only checks shape; it doesn't mutate the body.
  const body = {
    worker: "dev",
    task: {
      goal: "x",
      expected_outputs: ["a.md"],
      success_criteria: ["green"],
    },
  };
  assert.deepEqual(validateDispatchBody(body, KNOWN), { ok: true });
  // Body must not be mutated.
  assert.deepEqual(body.task.expected_outputs, ["a.md"]);
});

test("validateDispatchBody rejects non-object bodies with 400", () => {
  for (const bad of [null, undefined, "string", 123, [], true]) {
    const r = validateDispatchBody(bad, KNOWN);
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.match(r.error, /body must be an object/);
  }
});

test("validateDispatchBody rejects missing/empty worker with 400", () => {
  for (const body of [{}, { worker: "" }, { worker: 123 }, { task: {} }]) {
    const r = validateDispatchBody(body, KNOWN);
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.match(r.error, /'worker'/);
  }
});

test("validateDispatchBody rejects unknown role with 400 and helpful message", () => {
  const r = validateDispatchBody(
    { worker: "ghost", task: { goal: "x" } },
    KNOWN,
  );
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /unknown role 'ghost'/);
  assert.match(r.error, /ceo, dev/); // shows known roles
});

test("validateDispatchBody rejects missing task with 400", () => {
  for (const body of [
    { worker: "dev" },
    { worker: "dev", task: null },
    { worker: "dev", task: "not an object" },
    { worker: "dev", task: [] },
  ]) {
    const r = validateDispatchBody(body, KNOWN);
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.match(r.error, /'task'/);
  }
});

test("validateDispatchBody rejects missing/empty task.goal with 400", () => {
  for (const body of [
    { worker: "dev", task: {} },
    { worker: "dev", task: { goal: "" } },
    { worker: "dev", task: { goal: 123 } },
  ]) {
    const r = validateDispatchBody(body, KNOWN);
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.match(r.error, /'task\.goal'/);
  }
});

test("validateDispatchBody handles empty/missing knownRoles list cleanly", () => {
  const r = validateDispatchBody(
    { worker: "ceo", task: { goal: "x" } },
    [],
  );
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /known: none/);
});

// ---------------------------------------------------------------------------
// buildTaskId
// ---------------------------------------------------------------------------

test("buildTaskId produces a sortable timestamp + 8hex suffix", () => {
  const fixed = new Date("2026-04-27T10:30:45.123Z");
  // Deterministic random for the suffix.
  const fakeRandom = () => Buffer.from([0xa1, 0xb2, 0xc3, 0xd4]);
  const id = buildTaskId(fixed, fakeRandom);
  assert.equal(id, "2026-04-27T10-30-45-123Z-a1b2c3d4");
});

test("buildTaskId IDs sort lexicographically with chronological order", () => {
  const earlier = buildTaskId(new Date("2026-04-27T10:30:45.123Z"), () =>
    Buffer.from([0, 0, 0, 0]),
  );
  const later = buildTaskId(new Date("2026-04-27T10:30:46.000Z"), () =>
    Buffer.from([0, 0, 0, 0]),
  );
  assert.ok(earlier < later, `expected ${earlier} < ${later}`);
});

test("buildTaskId is unique across rapid calls (real randomness)", () => {
  const ids = new Set();
  for (let i = 0; i < 100; i++) ids.add(buildTaskId());
  // 100 calls within the same millisecond should still yield 100 unique
  // IDs because of the 32-bit random suffix.
  assert.equal(ids.size, 100);
});

// ---------------------------------------------------------------------------
// buildDispatchYaml
// ---------------------------------------------------------------------------

test("buildDispatchYaml injects source, preserves task fields", () => {
  const yaml = buildDispatchYaml(
    { goal: "write hello", expected_outputs: ["hi.md"] },
    "agent:ceo",
  );
  const parsed = parseYaml(yaml);
  assert.equal(parsed.source, "agent:ceo");
  assert.equal(parsed.goal, "write hello");
  assert.deepEqual(parsed.expected_outputs, ["hi.md"]);
});

test("buildDispatchYaml: caller-supplied 'source' is overridden by the authoritative one", () => {
  // The audit trail relies on `source` being trustworthy. If a
  // misbehaving (or careless) caller passes their own `source`, we
  // override it. This test pins the security-relevant behavior down
  // so a future refactor can't silently flip the spread order.
  const yaml = buildDispatchYaml(
    { source: "user", goal: "sneaky" },
    "agent:ceo",
  );
  const parsed = parseYaml(yaml);
  assert.equal(parsed.source, "agent:ceo", "injected source must win");
});

test("buildDispatchYaml output is parseable by the QueuePoller's yaml.parse", () => {
  // QueuePoller uses the same `yaml` package's parse — round-trip
  // protects against an output format that the poller can't read.
  const yaml = buildDispatchYaml(
    { goal: "delegate", inputs: ["spec/foo.md"], scope: ["src/foo.ts"] },
    "agent:ceo",
  );
  const parsed = parseYaml(yaml);
  assert.equal(parsed.goal, "delegate");
  assert.deepEqual(parsed.inputs, ["spec/foo.md"]);
  assert.deepEqual(parsed.scope, ["src/foo.ts"]);
});
