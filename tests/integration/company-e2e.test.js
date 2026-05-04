/**
 * Company runtime end-to-end smoke test.
 *
 * Drives the full task-pickup loop with a real hermes-agent container:
 *   1. Spin up CompanyRuntime against a tempdir project
 *   2. Drop an echo task in the queue
 *   3. Wait for the CEO to write result.md to the project root
 *   4. Stop the runtime, assert no containers leaked
 *
 * Heavy gates — never runs as part of the default suite:
 *   - RUN_E2E_TESTS=1                         opt-in (this test costs LLM tokens)
 *   - ANTHROPIC_API_KEY                       CEO needs an LLM to reason
 *   - docker reachable + hermes-agent:dev built
 *
 * Run:
 *   RUN_E2E_TESTS=1 ANTHROPIC_API_KEY=... \
 *     node --test tests/integration/company-e2e.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { CompanyRuntime } from "../../src/core/company-runtime.js";
import { dockerRunnerFactory } from "../../src/runners/hermes-docker.js";

const IMAGE = "hermes-agent:dev";
const RESULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

function gate() {
  if (process.env.RUN_E2E_TESTS !== "1") {
    return { skip: "RUN_E2E_TESTS!=1 (LLM cost gate; set to 1 to run)" };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { skip: "ANTHROPIC_API_KEY not set; CEO cannot reason without an LLM" };
  }
  const info = spawnSync("docker", ["info"], { stdio: "ignore" });
  if (info.status !== 0) return { skip: "docker daemon not reachable" };
  const inspect = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
  if (inspect.status !== 0) {
    return { skip: `${IMAGE} not built — run: docker build -f Dockerfile.hermes-agent -t ${IMAGE} .` };
  }
  return { skip: false };
}

async function writeMinimalOrg(projectRoot) {
  const orgDir = path.join(projectRoot, ".specify", "org");
  const agentsDir = path.join(orgDir, "agents");
  await fs.mkdir(agentsDir, { recursive: true });

  await fs.writeFile(
    path.join(orgDir, "constitution.md"),
    [
      "---",
      'schema_version: "1.0"',
      'company_name: "e2e-test-co"',
      "---",
      "",
      "# Constitution",
      "",
      "Single CEO agent. Echo tasks back as files.",
      "",
    ].join("\n")
  );

  await fs.writeFile(
    path.join(agentsDir, "ceo.md"),
    [
      "---",
      'schema_version: "1.0"',
      "role: ceo",
      'model: "claude-opus-4-7"',
      "runner: hermes",
      "runner_type: persistent",
      "reports_to: null",
      "skills: []",
      "tools:",
      "  builtin: [Read, Write]",
      "  mcp: []",
      "capabilities: [filesystem:read, filesystem:write, shell:execute, network:http, secrets:read_env]",
      "status: active",
      "---",
      "",
      "# CEO",
      "",
      "You execute tasks dropped into the queue. For each task, follow the goal precisely.",
      "When the goal is to write a file, create that file in the project root.",
      "",
    ].join("\n")
  );
}

async function fileEventually(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      return content;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

function runningContainersForSlug(slug) {
  const result = spawnSync("docker", [
    "ps",
    "--filter",
    `name=hermes-agent_${slug}_`,
    "--format",
    "{{.Names}}",
  ]);
  return (result.stdout?.toString() ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function noContainersAfter(slug, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runningContainersForSlug(slug).length === 0) return [];
    await new Promise((r) => setTimeout(r, 250));
  }
  return runningContainersForSlug(slug);
}

const { skip } = gate();

test("E2E: task → CEO container → result.md", { skip, timeout: 120_000 }, async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "haex-e2e-"));
  const slug = "e2e";
  const ceoQueueDir = path.join(projectRoot, ".specifyr", slug, "queue-ceo");
  await fs.mkdir(ceoQueueDir, { recursive: true });
  await writeMinimalOrg(projectRoot);

  const runtime = new CompanyRuntime({
    projectRoot,
    orgDir: path.join(projectRoot, ".specify", "org"),
    queueDirs: { ceo: ceoQueueDir },
    runnerFactory: dockerRunnerFactory({
      projectRoot,
      // CEO needs the LLM key to actually reason. capability-to-docker
      // throws if we pass secrets without secrets:read_env on the agent —
      // the spec above grants it.
      secretsResolver: (agent) =>
        agent?.capabilities?.includes("secrets:read_env")
          ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
          : undefined,
    }),
  });

  t.after(async () => {
    try {
      await runtime.stop();
    } catch {
      /* best effort */
    }
    // Belt-and-braces: kill any orphan containers
    spawnSync("docker", ["rm", "-f", ...runningContainersForSlug(slug)], { stdio: "ignore" });
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  // Surface dispatch outcome to stderr so failures stay diagnosable
  // (silent-failure path bit us once already; never again).
  runtime.on("dispatched", (p) => {
    if (p.result?.status !== "completed") {
      console.error(
        "[dispatched non-success]",
        JSON.stringify(
          {
            role: p.role,
            status: p.result?.status,
            summary: p.result?.summary,
            transcript: p.result?.transcript?.slice(0, 1000),
            metadata: p.result?.metadata,
          },
          null,
          2
        )
      );
    }
  });
  runtime.on("dispatch-error", (p) => {
    console.error("[dispatch-error]", p.path, p.error?.message ?? p.error);
  });

  await runtime.start();

  // Drop the task — CEO is expected to read this and produce result.md.
  await fs.writeFile(
    path.join(ceoQueueDir, "echo.yaml"),
    [
      'goal: "Write the literal string \\"hello\\" into a file named result.md at the project root."',
      'expected_outputs: ["result.md"]',
      "",
    ].join("\n")
  );

  const resultPath = path.join(projectRoot, "result.md");
  const content = await fileEventually(resultPath, RESULT_TIMEOUT_MS);
  assert.ok(content !== null, `result.md did not appear within ${RESULT_TIMEOUT_MS}ms`);
  assert.match(content, /hello/i);

  await runtime.stop();

  // --rm should remove containers on exit, but timing is racy when the
  // container exits and the docker daemon hasn't pruned the record yet.
  // Poll up to 5s for cleanup before failing.
  const stragglers = await noContainersAfter(slug, 5000);
  assert.deepEqual(stragglers, [], `expected no leaked containers, got: ${stragglers.join(", ")}`);
});
