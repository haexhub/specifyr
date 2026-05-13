import test from "node:test";
import assert from "node:assert/strict";

import {
  companyNetworkName,
  ensureCompanyNetwork,
  removeCompanyNetwork,
} from "../../src/runners/company-network.js";

/**
 * Build a stub commandRunner that records every invocation and replays
 * scripted responses by docker subcommand. Anything not scripted falls
 * back to a generic `ok:true` (so tests focus on the cases that matter).
 */
function stubRunner(scripts = {}) {
  const calls = [];
  const runner = async (cmd, args /* , opts */) => {
    calls.push({ cmd, args });
    const key = args.slice(0, 2).join(" ");
    const handler = scripts[key];
    if (typeof handler === "function") return handler(args);
    if (handler !== undefined) return handler;
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

test("companyNetworkName: prefixes co- and accepts safe ids", () => {
  assert.equal(companyNetworkName("my-slug_42"), "co-my-slug_42");
});

test("companyNetworkName: rejects empty / whitespace ids", () => {
  assert.throws(() => companyNetworkName(""), /companyId is required/);
  assert.throws(() => companyNetworkName("   "), /companyId is required/);
});

test("companyNetworkName: rejects characters docker won't accept", () => {
  assert.throws(() => companyNetworkName("a b"), /not allowed/);
  assert.throws(() => companyNetworkName("a/b"), /not allowed/);
  assert.throws(() => companyNetworkName("a$b"), /not allowed/);
});

test("ensureCompanyNetwork: creates when missing, attaches peers", async () => {
  const { runner, calls } = stubRunner({
    "network inspect": { ok: false, stderr: "No such network" },
    "network create": { ok: true, stdout: "abc123" },
    "network connect": { ok: true },
  });

  const result = await ensureCompanyNetwork({
    companyId: "slug-1",
    peers: ["specifyr-dev", "claude-proxy"],
    commandRunner: runner,
  });

  assert.deepEqual(result, {
    name: "co-slug-1",
    created: true,
    attached: ["specifyr-dev", "claude-proxy"],
  });

  // create call carries label so we can identify the network later.
  const create = calls.find((c) => c.args[0] === "network" && c.args[1] === "create");
  assert.ok(create, "expected network create");
  assert.ok(create.args.includes("com.specifyr.company=slug-1"));
  assert.ok(create.args.includes("com.specifyr.kind=company-network"));
});

test("ensureCompanyNetwork: idempotent — skips create when network exists", async () => {
  const { runner, calls } = stubRunner({
    "network inspect": { ok: true, stdout: "[{...}]" },
    "network connect": { ok: true },
  });

  const result = await ensureCompanyNetwork({
    companyId: "x",
    peers: ["specifyr"],
    commandRunner: runner,
  });

  assert.equal(result.created, false);
  assert.equal(result.attached.length, 1);
  const createCall = calls.find((c) => c.args[0] === "network" && c.args[1] === "create");
  assert.equal(createCall, undefined, "should not create when network already exists");
});

test("ensureCompanyNetwork: 'already connected' on peer is treated as success", async () => {
  const { runner } = stubRunner({
    "network inspect": { ok: true },
    "network connect": {
      ok: false,
      stderr: "Error response from daemon: endpoint with name specifyr already exists in network co-x",
    },
  });

  const result = await ensureCompanyNetwork({
    companyId: "x",
    peers: ["specifyr"],
    commandRunner: runner,
  });

  assert.deepEqual(result.attached, ["specifyr"]);
});

test("ensureCompanyNetwork: unknown connect failure is logged but does not throw", async () => {
  const logs = [];
  const { runner } = stubRunner({
    "network inspect": { ok: true },
    "network connect": { ok: false, stderr: "weird docker error" },
  });

  const result = await ensureCompanyNetwork({
    companyId: "x",
    peers: ["broken-peer"],
    onLog: (m) => logs.push(m),
    commandRunner: runner,
  });

  assert.deepEqual(result.attached, []);
  assert.ok(logs.some((l) => l.includes("could not attach broken-peer")),
    "expected warning to be logged");
});

test("ensureCompanyNetwork: throws when create itself fails (start should abort)", async () => {
  const { runner } = stubRunner({
    "network inspect": { ok: false },
    "network create": { ok: false, stderr: "Pool overlaps with other one on this address space" },
  });

  await assert.rejects(
    ensureCompanyNetwork({ companyId: "x", commandRunner: runner }),
    /failed to create network 'co-x'/,
  );
});

test("ensureCompanyNetwork: skips falsy peers without error", async () => {
  const { runner, calls } = stubRunner({
    "network inspect": { ok: true },
    "network connect": { ok: true },
  });

  await ensureCompanyNetwork({
    companyId: "x",
    peers: ["specifyr", null, "", undefined],
    commandRunner: runner,
  });

  const connects = calls.filter((c) => c.args[0] === "network" && c.args[1] === "connect");
  assert.equal(connects.length, 1);
});

test("removeCompanyNetwork: disconnects peers (force) then removes network", async () => {
  const { runner, calls } = stubRunner({
    "network disconnect": { ok: true },
    "network rm": { ok: true },
  });

  const result = await removeCompanyNetwork({
    companyId: "y",
    peers: ["specifyr", "claude-proxy"],
    commandRunner: runner,
  });

  assert.deepEqual(result, { name: "co-y", removed: true });

  const disconnects = calls.filter((c) => c.args[1] === "disconnect");
  assert.equal(disconnects.length, 2);
  for (const c of disconnects) {
    assert.ok(c.args.includes("--force"),
      "disconnect must be --force so a running container can be detached");
  }
});

test("removeCompanyNetwork: silent on 'no such network' (idempotent cleanup)", async () => {
  const logs = [];
  const { runner } = stubRunner({
    "network rm": { ok: false, stderr: "Error: No such network: co-y" },
  });

  const result = await removeCompanyNetwork({
    companyId: "y",
    onLog: (m) => logs.push(m),
    commandRunner: runner,
  });

  assert.equal(result.removed, false);
  assert.equal(logs.length, 0, "no warning for the desired end state");
});

test("removeCompanyNetwork: never throws even if docker is unreachable", async () => {
  const { runner } = stubRunner({
    "network disconnect": async () => { throw new Error("docker down"); },
    "network rm": async () => { throw new Error("docker down"); },
  });

  // .catch(() => …) inside the helper must swallow the rejection.
  const result = await removeCompanyNetwork({
    companyId: "z",
    peers: ["specifyr"],
    commandRunner: runner,
  });
  assert.equal(result.removed, false);
});
