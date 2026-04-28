import test from "node:test";
import assert from "node:assert/strict";

import { extractBearer, tokensMatch } from "../src/core/mcp-auth.js";

test("extractBearer pulls token from a well-formed header", () => {
  assert.equal(extractBearer("Bearer abcdef"), "abcdef");
  assert.equal(extractBearer("bearer ABC123"), "ABC123"); // case-insensitive
  assert.equal(extractBearer("  Bearer    spacey-token  "), "spacey-token");
});

test("extractBearer returns null on missing/malformed headers", () => {
  assert.equal(extractBearer(undefined), null);
  assert.equal(extractBearer(null), null);
  assert.equal(extractBearer(""), null);
  assert.equal(extractBearer("Basic dXNlcjpwYXNz"), null);
  assert.equal(extractBearer("Bearer"), null); // no token after Bearer
  assert.equal(extractBearer("Token abc"), null);
});

test("tokensMatch returns true for identical tokens", () => {
  const t = "a".repeat(64);
  assert.equal(tokensMatch(t, t), true);
});

test("tokensMatch returns false for different-content tokens of same length", () => {
  assert.equal(tokensMatch("a".repeat(64), "b".repeat(64)), false);
});

test("tokensMatch returns false (does not throw) on length mismatch", () => {
  assert.equal(tokensMatch("short", "much-longer-token"), false);
});

test("tokensMatch handles non-string inputs without throwing", () => {
  assert.equal(tokensMatch(undefined, "x"), false);
  assert.equal(tokensMatch("x", undefined), false);
  assert.equal(tokensMatch(123, "x"), false);
  assert.equal(tokensMatch(null, null), false);
});
