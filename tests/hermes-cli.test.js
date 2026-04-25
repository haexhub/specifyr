import test from "node:test";
import assert from "node:assert/strict";

import { HermesCliRunner } from "../src/runners/hermes-cli.js";

const fakeContext = {
  slug: "test",
  cwd: "/tmp/test",
  pattern: { name: "test-pattern" },
  provider: { name: "stub" },
};

const fakeWorkItem = {
  goal: "do thing",
  inputs: ["a"],
  scope: ["scope1"],
  successCriteria: ["pass"],
  expectedOutputs: ["out.md"],
  title: "test work item",
};

test("HermesCliRunner passes HERMES_HOME via env when memoryRoot is set", async () => {
  let captured = null;
  const fakeCommandRunner = async (cmd, args, opts) => {
    captured = { cmd, args, opts };
    return { ok: true, stdout: "done", stderr: "" };
  };

  const runner = new HermesCliRunner({
    memoryRoot: "/tmp/.hermes/ceo",
    commandRunner: fakeCommandRunner,
  });
  await runner.execute(fakeWorkItem, fakeContext);

  assert.ok(captured, "commandRunner should have been called");
  assert.deepEqual(captured.opts.env, { HERMES_HOME: "/tmp/.hermes/ceo" });
});

test("HermesCliRunner does NOT set env when memoryRoot is omitted", async () => {
  let captured = null;
  const fakeCommandRunner = async (cmd, args, opts) => {
    captured = { cmd, args, opts };
    return { ok: true, stdout: "done", stderr: "" };
  };

  const runner = new HermesCliRunner({ commandRunner: fakeCommandRunner });
  await runner.execute(fakeWorkItem, fakeContext);

  assert.equal(captured.opts.env, undefined);
});
