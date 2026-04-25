import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { hermesHomeForAgent } from "../src/runners/hermes-paths.js";

test("hermesHomeForAgent composes <projectRoot>/.hermes/<role>", () => {
  const out = hermesHomeForAgent({ projectRoot: "/tmp/myproj", role: "ceo" });
  assert.equal(out, path.join("/tmp/myproj", ".hermes", "ceo"));
});

test("hermesHomeForAgent rejects path-traversal in role", () => {
  assert.throws(
    () => hermesHomeForAgent({ projectRoot: "/tmp/myproj", role: "../escape" }),
    /invalid role/
  );
});

test("hermesHomeForAgent requires projectRoot", () => {
  assert.throws(
    () => hermesHomeForAgent({ role: "ceo" }),
    /projectRoot required/
  );
});

test("hermesHomeForAgent rejects empty role", () => {
  assert.throws(
    () => hermesHomeForAgent({ projectRoot: "/tmp", role: "" }),
    /invalid role/
  );
});
