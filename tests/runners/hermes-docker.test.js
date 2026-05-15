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

// Helper: docker argv layout is `run, ...flags, IMAGE, ...cmdArgs`. The
// image is immediately followed by `hermes` (the CMD override). This
// finds the image position so individual tests don't have to count flags.
function imageIndex(args) {
  const i = args.indexOf("hermes");
  return i > 0 ? i - 1 : -1;
}

test("invokes 'docker run ...' with capability-derived flags + chat command", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    commandRunner: fakeCommandRunner,
  });

  await runner.execute(fakeWorkItem(), fakeContext());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "docker");
  assert.equal(calls[0].args[0], "run");
  // image sits between docker flags and the CMD-override (hermes ...).
  const idx = imageIndex(calls[0].args);
  assert.ok(idx >= 1, `expected image position, got ${idx}`);
  assert.equal(calls[0].args[idx], "hermes-agent:dev");
  // chat command immediately follows the image.
  assert.deepEqual(calls[0].args.slice(idx + 1, idx + 4), ["hermes", "chat", "--provider"]);
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

test("compose project label derives from runtimeContext.slug when not injected", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    commandRunner: fakeCommandRunner,
  });
  await runner.execute(fakeWorkItem(), fakeContext());

  assert.ok(
    calls[0].args.includes("com.docker.compose.project=test-slug"),
    "expected compose project label using runtimeContext.slug"
  );
  assert.ok(
    calls[0].args.includes("com.docker.compose.service=ceo"),
    "expected compose service label using agent.role"
  );
});

test("compose project label sanitises slug like the container name does", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    commandRunner: fakeCommandRunner,
  });
  const ctx = fakeContext();
  ctx.slug = "weird/slug:with*chars";
  await runner.execute(fakeWorkItem(), ctx);

  assert.ok(
    calls[0].args.includes("com.docker.compose.project=weird_slug_with_chars"),
    "compose project must use the same sanitiser as container names"
  );
});

test("explicit composeProject from constructor wins over runtimeContext.slug", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    composeProject: "injected-slug",
    composeService: "injected-svc",
    commandRunner: fakeCommandRunner,
  });
  await runner.execute(fakeWorkItem(), fakeContext());

  assert.ok(calls[0].args.includes("com.docker.compose.project=injected-slug"));
  assert.ok(calls[0].args.includes("com.docker.compose.service=injected-svc"));
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
  assert.match(calls[0].args[i + 1], /^hermes-agent_weird_slug_with_chars_ceo_[0-9a-z]+$/);
});

test("prompt is passed as `hermes chat -q <prompt>` arg, not stdin", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    commandRunner: fakeCommandRunner,
  });
  await runner.execute(fakeWorkItem({ goal: "summarize the readme" }), fakeContext());

  // No stdin piping any more — hermes 0.11 reads -q QUERY from argv.
  assert.equal(calls[0].opts.input, undefined, "stdin must not be piped");

  const args = calls[0].args;
  const qIdx = args.lastIndexOf("-q");
  assert.ok(qIdx >= 0, "expected -q QUERY in argv");
  const prompt = args[qIdx + 1];
  assert.match(prompt, /summarize the readme/);
  assert.match(prompt, /Pattern: test-pattern/);
});

test("hermes chat invocation uses --yolo, --max-turns; does NOT use --ignore-user-config", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    commandRunner: fakeCommandRunner,
  });
  await runner.execute(fakeWorkItem(), fakeContext());

  const args = calls[0].args;
  assert.ok(args.includes("--yolo"));
  // --ignore-user-config would suppress $HERMES_HOME/config.yaml (the pre-seeded profile),
  // causing the first-run wizard to fire in non-interactive containers.
  assert.ok(!args.includes("--ignore-user-config"));
  const maxIdx = args.indexOf("--max-turns");
  assert.ok(maxIdx >= 0);
  assert.match(args[maxIdx + 1], /^\d+$/);
});

test("--user is set to host uid:gid by default (cap-drop=ALL needs UID match for bind-mount writes)", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    commandRunner: fakeCommandRunner,
  });
  await runner.execute(fakeWorkItem(), fakeContext());

  const idx = calls[0].args.indexOf("--user");
  assert.ok(idx >= 0, "expected --user flag");
  assert.match(calls[0].args[idx + 1], /^\d+:\d+$/);
});

test("--user can be overridden explicitly", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    userId: "1234:1234",
    commandRunner: fakeCommandRunner,
  });
  await runner.execute(fakeWorkItem(), fakeContext());

  const idx = calls[0].args.indexOf("--user");
  assert.equal(calls[0].args[idx + 1], "1234:1234");
});

test("--user can be omitted with userId: null (run as image USER)", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    userId: null,
    commandRunner: fakeCommandRunner,
  });
  await runner.execute(fakeWorkItem(), fakeContext());

  assert.equal(calls[0].args.indexOf("--user"), -1);
});

test("agent.model determines `-m anthropic/<model>`; namespaced models pass through", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();

  const a = new HermesDockerRunner({
    ...baseRunnerOptions({
      agent: { role: "ceo", capabilities: ["shell:execute"], model: "claude-opus-4-7" },
    }),
    commandRunner: fakeCommandRunner,
  });
  await a.execute(fakeWorkItem(), fakeContext());
  let mIdx = calls[0].args.indexOf("-m");
  assert.equal(calls[0].args[mIdx + 1], "anthropic/claude-opus-4-7");

  calls.length = 0;
  const b = new HermesDockerRunner({
    ...baseRunnerOptions({
      agent: { role: "ceo", capabilities: ["shell:execute"], model: "openai/gpt-4o" },
    }),
    commandRunner: fakeCommandRunner,
  });
  await b.execute(fakeWorkItem(), fakeContext());
  mIdx = calls[0].args.indexOf("-m");
  assert.equal(calls[0].args[mIdx + 1], "openai/gpt-4o", "already-namespaced model passes through");
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

test("non-zero docker exit surfaces 'failed' with stderr (no silent fallback)", async () => {
  const { fakeCommandRunner } = makeFakeRunner({
    ok: false,
    code: 125,
    stdout: "",
    stderr: "docker: network 'companies' not found.\nSee 'docker run --help'.",
  });
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    commandRunner: fakeCommandRunner,
  });
  const result = await runner.execute(fakeWorkItem(), fakeContext());

  // Crucial: do NOT fall back to the stub (status:"completed" would hide
  // a real failure). The dispatcher needs to see status:"failed" so it
  // leaves the queue YAML in place for retry.
  assert.equal(result.status, "failed");
  assert.equal(result.metadata.runner, "hermes-docker");
  assert.equal(result.metadata.exitCode, 125);
  assert.match(result.summary, /network 'companies' not found/);
  assert.match(result.transcript, /docker:/);
});

test("ok=true with empty stdout still counts as completed (hermes did file-tool work without printing)", async () => {
  const { fakeCommandRunner } = makeFakeRunner({ ok: true, stdout: "", stderr: "" });
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions(),
    commandRunner: fakeCommandRunner,
  });
  const result = await runner.execute(fakeWorkItem(), fakeContext());

  assert.equal(result.status, "completed");
  assert.equal(result.metadata.runner, "hermes-docker");
  assert.match(result.summary, /no stdout/);
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

test("secrets KV emits -e KEY=value (caller-resolved allowlist)", async () => {
  const { fakeCommandRunner, calls } = makeFakeRunner();
  const runner = new HermesDockerRunner({
    ...baseRunnerOptions({
      agent: {
        role: "ceo",
        capabilities: ["filesystem:read", "shell:execute"],
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

  const idx = imageIndex(calls[0].args);
  assert.equal(calls[0].args[idx], "hermes-agent:0.2.1");
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

test("dockerRunnerFactory: composeProject is set from runtimeMeta.slug, composeService from agent.role", () => {
  const factory = dockerRunnerFactory({ projectRoot: "/p" });
  const runner = factory(
    { role: "ceo", capabilities: ["shell:execute"] },
    { slug: "my-project" }
  );
  assert.equal(runner.composeProject, "my-project");
  assert.equal(runner.composeService, "ceo");
});

test("dockerRunnerFactory: composeProject sanitises slug (matches persistent-container name rules)", () => {
  const factory = dockerRunnerFactory({ projectRoot: "/p" });
  const runner = factory(
    { role: "ceo", capabilities: ["shell:execute"] },
    { slug: "weird/slug:with*chars" }
  );
  assert.equal(runner.composeProject, "weird_slug_with_chars");
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
  const ceo = factory({ role: "ceo", capabilities: [], secrets: ["GH_TOKEN"] });
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
