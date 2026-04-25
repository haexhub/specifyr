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
 *   - E2E_DISPATCH_READY=1                    set ONLY when the queue-to-runner
 *                                             dispatch wiring is in place.
 *                                             Without it CompanyRuntime emits
 *                                             'task' events but never calls
 *                                             runner.execute(), so the test
 *                                             would just time out.
 *
 * Run:
 *   RUN_E2E_TESTS=1 ANTHROPIC_API_KEY=... E2E_DISPATCH_READY=1 \
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
  if (process.env.E2E_DISPATCH_READY !== "1") {
    return {
      skip:
        "E2E_DISPATCH_READY!=1: CompanyRuntime currently emits 'task' events " +
        "but does not yet call runner.execute() on them. Set E2E_DISPATCH_READY=1 " +
        "once the queue-to-runner dispatch wiring lands (see plan 6.5/6.7).",
    };
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
      "capabilities: [filesystem:read, filesystem:write, shell:execute]",
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

const { skip } = gate();

test("E2E: task → CEO container → result.md", { skip, timeout: 120_000 }, async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "haex-e2e-"));
  const slug = "e2e";
  const queueDir = path.join(projectRoot, ".specops", slug, "queue");
  await fs.mkdir(queueDir, { recursive: true });
  await writeMinimalOrg(projectRoot);

  const runtime = new CompanyRuntime({
    projectRoot,
    orgDir: path.join(projectRoot, ".specify", "org"),
    queueDir,
    runnerFactory: dockerRunnerFactory({
      projectRoot,
      // No catalog dir → binary whitelist comes from raw agent.tools.binaries
      // (empty for this minimal CEO spec). The container runs with the default
      // binary set and Hermes can write/read /workspace via filesystem capability.
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

  await runtime.start();

  // Drop the task — CEO is expected to read this and produce result.md.
  await fs.writeFile(
    path.join(queueDir, "echo.yaml"),
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

  // Allow Docker a beat to release the container records.
  await new Promise((r) => setTimeout(r, 1000));
  const stragglers = runningContainersForSlug(slug);
  assert.deepEqual(stragglers, [], `expected no leaked containers, got: ${stragglers.join(", ")}`);
});
