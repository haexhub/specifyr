import test from "node:test";
import assert from "node:assert/strict";

import { HermesDockerRunner, dockerRunnerFactory } from "../../src/runners/hermes-docker.js";

const fakeContext = () => ({
  slug: "test-slug",
  cwd: "/home/dev/proj",
  pattern: { name: "test-pattern" },
  provider: { name: "stub" },
});

const fakeWorkItem = (overrides = {}) => ({
  goal: "do thing",
  inputs: ["a"],
  scope: ["scope1"],
  successCriteria: ["pass"],
  expectedOutputs: ["out.md"],
  title: "test work item",
  ...overrides,
});

const baseRunnerOptions = (overrides = {}) => ({
  agent: { role: "ceo", capabilities: ["filesystem:read", "shell:execute"] },
  projectRoot: "/home/dev/proj",
  profileDir: "/home/dev/proj/.hermes/ceo",
  ...overrides,
});

function makeFakeRunner(returns = { ok: true, stdout: "result line one", stderr: "" }) {
  const calls = [];
  const fakeCommandRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return returns;
  };
  return { fakeCommandRunner, calls };
}

test("invokes 'docker run -i ...' with capability-derived flags", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    commandRunner: fakeCommandRunner,
  });

  await runner.execute(fakeWorkItem(), fakeContext());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "docker");
  assert.equal(calls[0].args[0], "run");
  assert.equal(calls[0].args[1], "-i");
  // image must be the very last positional argument
  assert.equal(calls[0].args[calls[0].args.length - 1], "hermes-agent:dev");
});

test("filesystem:read maps to read-only project bind mount", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    commandRunner: fakeCommandRunner,
  });
  await runner.execute(fakeWorkItem(), fakeContext());

  assert.ok(
    calls[0].args.includes("/home/dev/proj:/workspace:ro"),
    "expected ro bind mount of project root"
  );
});

test("filesystem:write maps to read-write project bind mount", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions({
      agent: { role: "dev", capabilities: ["filesystem:write", "shell:execute"] },
    }),
    commandRunner: fakeCommandRunner,
  });
  await runner.execute(fakeWorkItem(), fakeContext());

  assert.ok(calls[0].args.includes("/home/dev/proj:/workspace:rw"));
});

test("no network capability → --network=none", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    commandRunner: fakeCommandRunner,
  });
  await runner.execute(fakeWorkItem(), fakeContext());

  const i = calls[0].args.indexOf("--network");
  assert.ok(i >= 0);
  assert.equal(calls[0].args[i + 1], "none");
});

test("network:http + network name → joins that network", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions({
      agent: { role: "ceo", capabilities: ["shell:execute", "network:http"] },
    }),
    network: "companies",
    commandRunner: fakeCommandRunner,
  });
  await runner.execute(fakeWorkItem(), fakeContext());

  const i = calls[0].args.indexOf("--network");
  assert.equal(calls[0].args[i + 1], "companies");
});

test("binary whitelist becomes BINARY_WHITELIST env var", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    binaryWhitelist: ["git", "jq"],
    commandRunner: fakeCommandRunner,
  });
  await runner.execute(fakeWorkItem(), fakeContext());

  assert.ok(calls[0].args.includes("BINARY_WHITELIST=git,jq"));
});

test("HERMES_HOME profile mount + env var are always set", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    commandRunner: fakeCommandRunner,
  });
  await runner.execute(fakeWorkItem(), fakeContext());

  assert.ok(calls[0].args.includes("/home/dev/proj/.hermes/ceo:/profile:rw"));
  assert.ok(calls[0].args.includes("HERMES_HOME=/profile"));
});

test("container name derives from slug + role, sanitised", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions({
      agent: { role: "ceo", capabilities: ["shell:execute"] },
    }),
    commandRunner: fakeCommandRunner,
  });
  const ctx = fakeContext();
  ctx.slug = "weird/slug:with*chars";
  await runner.execute(fakeWorkItem(), ctx);

  const i = calls[0].args.indexOf("--name");
  assert.ok(i >= 0);
  assert.equal(calls[0].args[i + 1], "hermes-agent_weird_slug_with_chars_ceo");
});

test("prompt is piped via stdin to docker run", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    commandRunner: fakeCommandRunner,
  });
  await runner.execute(fakeWorkItem({ goal: "summarize the readme" }), fakeContext());

  const input = calls[0].opts.input;
  assert.ok(typeof input === "string");
  assert.match(input, /summarize the readme/);
  assert.match(input, /Pattern: test-pattern/);
});

test("returns completed result with metadata on successful invocation", async () => {
  const { fakeCommandRunner } = makeFakeRunner({
    ok: true,
    stdout: "first line of result\nmore detail",
    stderr: "",
  });
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    commandRunner: fakeCommandRunner,
  });

  const result = await runner.execute(fakeWorkItem(), fakeContext());

  assert.equal(result.status, "completed");
  assert.equal(result.summary, "first line of result");
  assert.equal(result.reviewStatus, "accepted");
  assert.equal(result.metadata.runner, "hermes-docker");
  assert.equal(result.metadata.role, "ceo");
  assert.equal(result.metadata.image, "hermes-agent:dev");
  assert.equal(result.transcript, "first line of result\nmore detail");
});

test("falls back to base stub when scope is empty (no docker invocation)", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    commandRunner: fakeCommandRunner,
  });
  const result = await runner.execute(fakeWorkItem({ scope: [] }), fakeContext());

  assert.equal(calls.length, 0, "docker should not have been invoked");
  assert.equal(result.status, "failed");
  assert.match(result.summary, /no explicit scope/);
});

test("falls back when commandRunner reports !ok", async () => {
  const { fakeCommandRunner } = makeFakeRunner({ ok: false, stdout: "", stderr: "boom" });
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    commandRunner: fakeCommandRunner,
  });
  const result = await runner.execute(fakeWorkItem(), fakeContext());

  // Fallback HermesAgentRunner (with valid scope) returns "completed".
  assert.equal(result.status, "completed");
  assert.equal(result.metadata.runner, "hermes-agent");
});

test("falls back when stdout is empty", async () => {
  const { fakeCommandRunner } = makeFakeRunner({ ok: true, stdout: "", stderr: "" });
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    commandRunner: fakeCommandRunner,
  });
  const result = await runner.execute(fakeWorkItem(), fakeContext());

  assert.equal(result.status, "completed");
  assert.equal(result.metadata.runner, "hermes-agent");
});

test("capability-mapping error THROWS instead of silently falling back", async () => {
  const { fakeCommandRunner } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions({
      agent: { role: "evil", capabilities: ["docker:privileged"] },
    }),
    commandRunner: fakeCommandRunner,
  });

  await assert.rejects(
    () => runner.execute(fakeWorkItem(), fakeContext()),
    /privileged/
  );
});

test("secrets without secrets:read_env grant THROWS (config drift)", async () => {
  const { fakeCommandRunner } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions({
      agent: { role: "ceo", capabilities: ["filesystem:read", "shell:execute"] },
    }),
    secrets: { GH_TOKEN: "ghp_xxx" },
    commandRunner: fakeCommandRunner,
  });

  await assert.rejects(
    () => runner.execute(fakeWorkItem(), fakeContext()),
    /lacks secrets:read_env/
  );
});

test("secrets WITH secrets:read_env grant emit -e KEY=value", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions({
      agent: {
        role: "ceo",
        capabilities: ["filesystem:read", "shell:execute", "secrets:read_env"],
      },
    }),
    secrets: { GH_TOKEN: "ghp_xxx" },
    commandRunner: fakeCommandRunner,
  });

  await runner.execute(fakeWorkItem(), fakeContext());
  assert.ok(calls[0].args.includes("GH_TOKEN=ghp_xxx"));
});

test("custom image tag is honoured", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    image: "hermes-agent:0.2.1",
    commandRunner: fakeCommandRunner,
  });
  await runner.execute(fakeWorkItem(), fakeContext());

  assert.equal(calls[0].args[calls[0].args.length - 1], "hermes-agent:0.2.1");
});

test("custom dockerCommand (e.g. podman) is honoured", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    dockerCommand: "podman",
    commandRunner: fakeCommandRunner,
  });
  await runner.execute(fakeWorkItem(), fakeContext());

  assert.equal(calls[0].cmd, "podman");
});

// ---------------------------------------------------------------------------
// dockerRunnerFactory — wires a HermesDockerRunner per agent for CompanyRuntime.
// ---------------------------------------------------------------------------

test("dockerRunnerFactory: returns a HermesDockerRunner per agent", () => {
  const factory = dockerRunnerFactory({ projectRoot: "/p" });
  const runner = factory({ role: "ceo", capabilities: ["shell:execute"] });
  assert.ok(runner instanceof HermesDockerRunner);
  assert.equal(runner.agent.role, "ceo");
});

test("dockerRunnerFactory: profileDir is derived from projectRoot + role", () => {
  const factory = dockerRunnerFactory({ projectRoot: "/home/dev/proj" });
  const runner = factory({ role: "dev", capabilities: [] });
  assert.equal(runner.profileDir, "/home/dev/proj/.hermes/dev");
});

test("dockerRunnerFactory: image, network propagate to runner", () => {
  const factory = dockerRunnerFactory({
    projectRoot: "/p",
    image: "hermes-agent:0.3.0",
    network: "companies",
  });
  const runner = factory({ role: "ceo", capabilities: [] });
  assert.equal(runner.image, "hermes-agent:0.3.0");
  assert.equal(runner.network, "companies");
});

test("dockerRunnerFactory: HERMES_AGENT_IMAGE env var overrides default", () => {
  const prev = process.env.HERMES_AGENT_IMAGE;
  process.env.HERMES_AGENT_IMAGE = "ghcr.io/example/hermes-agent:sha-abc";
  try {
    const factory = dockerRunnerFactory({ projectRoot: "/p" });
    const runner = factory({ role: "ceo", capabilities: [] });
    assert.equal(runner.image, "ghcr.io/example/hermes-agent:sha-abc");
  } finally {
    if (prev === undefined) delete process.env.HERMES_AGENT_IMAGE;
    else process.env.HERMES_AGENT_IMAGE = prev;
  }
});

test("dockerRunnerFactory: explicit cfg.image wins over HERMES_AGENT_IMAGE", () => {
  const prev = process.env.HERMES_AGENT_IMAGE;
  process.env.HERMES_AGENT_IMAGE = "ghcr.io/example/hermes-agent:sha-abc";
  try {
    const factory = dockerRunnerFactory({
      projectRoot: "/p",
      image: "hermes-agent:explicit",
    });
    const runner = factory({ role: "ceo", capabilities: [] });
    assert.equal(runner.image, "hermes-agent:explicit");
  } finally {
    if (prev === undefined) delete process.env.HERMES_AGENT_IMAGE;
    else process.env.HERMES_AGENT_IMAGE = prev;
  }
});

test("dockerRunnerFactory: falls back to 'hermes-agent:dev' when neither given", () => {
  const prev = process.env.HERMES_AGENT_IMAGE;
  delete process.env.HERMES_AGENT_IMAGE;
  try {
    const factory = dockerRunnerFactory({ projectRoot: "/p" });
    const runner = factory({ role: "ceo", capabilities: [] });
    assert.equal(runner.image, "hermes-agent:dev");
  } finally {
    if (prev !== undefined) process.env.HERMES_AGENT_IMAGE = prev;
  }
});

test("dockerRunnerFactory: with catalog, resolves wildcard binaries", () => {
  const catalog = {
    binaries: new Map([
      ["git", { id: "git" }],
      ["jq", { id: "jq" }],
      ["rg", { id: "rg" }],
    ]),
  };
  const factory = dockerRunnerFactory({ projectRoot: "/p" });
  const runner = factory(
    { role: "ceo", capabilities: [], tools: { binaries: ["*"] } },
    { catalog }
  );
  assert.deepEqual(runner.binaryWhitelist.sort(), ["git", "jq", "rg"]);
});

test("dockerRunnerFactory: without catalog, raw binaries pass through unexpanded", () => {
  const factory = dockerRunnerFactory({ projectRoot: "/p" });
  const runner = factory({
    role: "ceo",
    capabilities: [],
    tools: { binaries: ["git", "jq"] },
  });
  assert.deepEqual(runner.binaryWhitelist, ["git", "jq"]);
});

test("dockerRunnerFactory: secretsResolver is called per agent", () => {
  const seen = [];
  const factory = dockerRunnerFactory({
    projectRoot: "/p",
    secretsResolver: (a) => {
      seen.push(a.role);
      return a.role === "ceo" ? { GH_TOKEN: "ghp_x" } : {};
    },
  });
  const ceo = factory({ role: "ceo", capabilities: ["secrets:read_env"] });
  const dev = factory({ role: "dev", capabilities: [] });
  assert.deepEqual(seen, ["ceo", "dev"]);
  assert.deepEqual(ceo.secrets, { GH_TOKEN: "ghp_x" });
  assert.deepEqual(dev.secrets, {});
});

test("dockerRunnerFactory: throws if projectRoot missing", () => {
  assert.throws(() => dockerRunnerFactory({}), /projectRoot required/);
});

test("constructor refuses missing agent / projectRoot / profileDir", () => {
  assert.throws(
    () => new HermesDockerRunner({ projectRoot: "/p", profileDir: "/p/.h" }),
    /agent required/
  );
  assert.throws(
    () =>
      new HermesDockerRunner({
        agent: { role: "x", capabilities: [] },
        profileDir: "/p/.h",
      }),
    /projectRoot required/
  );
  assert.throws(
    () =>
      new HermesDockerRunner({
        agent: { role: "x", capabilities: [] },
        projectRoot: "/p",
      }),
    /profileDir required/
  );
});
