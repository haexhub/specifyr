import test from "node:test";
import assert from "node:assert/strict";
import { encodeSessionId, decodeSessionId } from "../../src/acp/session-id.js";

test("round-trips a normal triplet", () => {
  const id = encodeSessionId({ slug: "my-feature", stepId: "implement", sid: "abc123" });
  assert.deepEqual(decodeSessionId(id), { slug: "my-feature", stepId: "implement", sid: "abc123" });
});

test("rejects components containing the separator", () => {
  assert.throws(() => encodeSessionId({ slug: "a:b", stepId: "x", sid: "y" }), /separator/);
});

test("rejects malformed input on decode", () => {
  assert.throws(() => decodeSessionId("not-a-real-id"), /malformed/);
  assert.throws(() => decodeSessionId("specifyr:1:a:b"), /malformed/); // wrong arity
});

test("decodes only the specifyr scheme", () => {
  assert.throws(() => decodeSessionId("other:1:a:b:c"), /scheme/);
});
