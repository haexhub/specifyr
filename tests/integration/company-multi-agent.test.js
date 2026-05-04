/**
 * Multi-agent dispatch — two complementary tests:
 *
 *   1. SMOKETEST (always runs)
 *      Stub runner factory, no LLM, no Docker. The "CEO" runner
 *      programmatically uses the dispatch helpers to drop a sub-task
 *      into the dev queue. The dev runner writes a file. We verify the
 *      multi-agent flow end-to-end without paying for tokens or
 *      pulling images.
 *
 *      This is the "the mechanics work" test. CI-runnable.
 *
 *   2. LLM E2E (gated by RUN_E2E_TESTS=1)
 *      Real Docker workers, real Anthropic LLM. The CEO container is
 *      prompted to delegate to dev via HTTP POST to a test-spawned
 *      mini server that mounts the dispatch endpoint logic. The dev
 *      container then runs and writes its artefact.
 *
 *      Local-only ("bei lokalen tests auf jeden fall, in der CI nicht").
 *      Costs ~2x the CEO-only E2E because both agents call Anthropic.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";

import { CompanyRuntime } from "../../src/core/company-runtime.js";
import { dockerRunnerFactory } from "../../src/runners/hermes-docker.js";
import {
  buildDispatchYaml,
  buildTaskId,
  validateDispatchBody,
} from "../../src/core/mcp-dispatch.js";

const VALID_FIXTURE = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "fixtures",
  "spec-loader",
  "valid",
);

// ---------------------------------------------------------------------------
// 8.4a — SMOKETEST (no LLM, no Docker)
// ---------------------------------------------------------------------------

test("multi-agent smoketest: CEO delegates to dev via dispatch helpers", async () => {
  const proj = await fs.mkdtemp(path.join(os.tmpdir(), "ma-smoke-"));
  const queueCeo = path.join(proj, ".specifyr", "ma", "queue-ceo");
  const queueDev = path.join(proj, ".specifyr", "ma", "queue-dev");
  await fs.mkdir(queueCeo, { recursive: true });
  await fs.mkdir(queueDev, { recursive: true });

  let devArtifactPath = null;

  // The runner factory gates each role's behavior. The CEO simulates
  // what the real CEO container does when it receives a delegation
  // task: write a sub-task YAML into the dev queue using the same
  // helpers the dispatch endpoint uses. The dev runner writes a file.
  const runnerFactory = (agent) => ({
    async execute(workItem) {
      if (agent.role === "ceo") {
        const yamlText = buildDispatchYaml(
          {
            goal: "write hello from dev into dev-result.md",
            expected_outputs: ["dev-result.md"],
          },
          "agent:ceo",
        );
        const taskId = buildTaskId();
        await fs.writeFile(path.join(queueDev, `${taskId}.yaml`), yamlText);
        return { status: "completed", outputs: ["dispatched-to-dev"] };
      }
      if (agent.role === "dev") {
        // Dev would normally read its goal and write the artifact via
        // its capabilities. We simulate the side-effect directly.
        devArtifactPath = path.join(proj, "dev-result.md");
        await fs.writeFile(devArtifactPath, "hello from dev\n");
        return { status: "completed", outputs: workItem.expectedOutputs };
      }
      throw new Error(`smoketest: unexpected role '${agent.role}'`);
    },
  });

  const runtime = new CompanyRuntime({
    projectRoot: proj,
    orgDir: VALID_FIXTURE,
    queueDirs: { ceo: queueCeo, dev: queueDev },
    slug: "ma",
    runnerFactory,
  });

  try {
    await runtime.start();

    // We expect TWO dispatched events: CEO completes, then dev completes.
    let dispatchedRoles = [];
    const bothDispatched = new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`only got: ${JSON.stringify(dispatchedRoles)}`)),
        5000,
      );
      runtime.on("dispatched", (evt) => {
        dispatchedRoles.push(evt.role);
        if (dispatchedRoles.length === 2) {
          clearTimeout(t);
          resolve();
        }
      });
    });

    // Drop the initial CEO task — same pattern the user would use.
    await fs.writeFile(
      path.join(queueCeo, "delegate.yaml"),
      'goal: "delegate to dev"\n',
    );

    await bothDispatched;

    // CEO went first, dev second (CEO produces the dev queue entry).
    assert.deepEqual(dispatchedRoles, ["ceo", "dev"], "expected CEO → dev order");

    // The dev runner produced the artefact.
    assert.ok(devArtifactPath, "dev runner did not run");
    const content = await fs.readFile(devArtifactPath, "utf8");
    assert.match(content, /hello from dev/);

    // Both queue dirs should be empty after the run (consumed).
    const ceoQueue = await fs.readdir(queueCeo);
    const devQueue = await fs.readdir(queueDev);
    assert.deepEqual(ceoQueue, [], `CEO queue not drained: ${ceoQueue}`);
    assert.deepEqual(devQueue, [], `dev queue not drained: ${devQueue}`);
  } finally {
    await runtime.stop();
    await fs.rm(proj, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8.4b — LLM E2E (gated; real Docker + Anthropic)
// ---------------------------------------------------------------------------

const IMAGE = "hermes-agent:dev";
const RESULT_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 500;
// Linux Docker bridge default gateway. Containers reach the host via this IP
// when they have `--network <name>` or the default bridge. macOS/Windows
// would need `host.docker.internal` instead — flagged in the skip message.
const HOST_GATEWAY_IP = process.env.HAEX_TEST_HOST_GATEWAY ?? "172.17.0.1";

function gateE2E() {
  if (process.env.RUN_E2E_TESTS !== "1") {
    return { skip: "RUN_E2E_TESTS!=1 (LLM cost gate; set to 1 to run)" };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { skip: "ANTHROPIC_API_KEY not set; CEO cannot reason without an LLM" };
  }
  if (process.platform !== "linux") {
    return {
      skip: `LLM E2E currently assumes Linux Docker bridge gateway (${HOST_GATEWAY_IP}); on ${process.platform} set HAEX_TEST_HOST_GATEWAY to host.docker.internal`,
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

/**
 * Spawn a minimal HTTP server that mounts ONLY the dispatch endpoint.
 * Mirrors what `server/api/mcp/[slug]/dispatch.post.ts` does, but
 * without Nitro — pure Node.
 *
 * Returns { url, port, close } where url is "http://0.0.0.0:<port>" and
 * the dispatch path is `/mcp/<slug>/dispatch`.
 */
async function startDispatchServer({ runtime, expectedToken }) {
  const server = http.createServer(async (req, res) => {
    try {
      // Path: /mcp/<slug>/dispatch
      const m = req.url?.match(/^\/mcp\/([^/]+)\/dispatch$/);
      if (!m || req.method !== "POST") {
        res.writeHead(404).end("not found");
        return;
      }
      const slug = m[1];
      if (slug !== runtime.slug) {
        res.writeHead(404).end(`no runtime for slug '${slug}'`);
        return;
      }

      // Bearer auth — same shape as mcp-auth.ts
      const auth = req.headers.authorization ?? "";
      const provided = auth.match(/^Bearer\s+(.+)$/i)?.[1];
      if (!provided || provided !== expectedToken) {
        res.writeHead(401).end("unauthorized");
        return;
      }

      // Read body
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400).end("invalid JSON");
        return;
      }

      const knownRoles = runtime.listAgents().map((a) => a.role);
      const v = validateDispatchBody(body, knownRoles);
      if (!v.ok) {
        res.writeHead(v.status).end(v.error);
        return;
      }

      const queueDir = runtime.getRoleQueueDir(body.worker);
      if (!queueDir) {
        res.writeHead(500).end(`no queue for role '${body.worker}'`);
        return;
      }
      const taskId = buildTaskId();
      const filepath = path.join(queueDir, `${taskId}.yaml`);
      const yamlText = buildDispatchYaml(body.task, `agent:${runtime.ceoRole}`);
      await fs.writeFile(filepath, yamlText);

      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ dispatched: true, role: body.worker, path: filepath, taskId }),
      );
    } catch (err) {
      res.writeHead(500).end(`internal: ${err?.message ?? err}`);
    }
  });

  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = server.address().port;
  return {
    url: `http://${HOST_GATEWAY_IP}:${port}`,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function writeMultiAgentOrg(projectRoot, opsUrl, opsToken) {
  const orgDir = path.join(projectRoot, ".specify", "org");
  const agentsDir = path.join(orgDir, "agents");
  await fs.mkdir(agentsDir, { recursive: true });

  await fs.writeFile(
    path.join(orgDir, "constitution.md"),
    [
      "---",
      'schema_version: "1.0"',
      'company_name: "ma-e2e-co"',
      "---",
      "",
      "# Constitution",
      "",
      "Two-agent company: CEO delegates to Dev.",
      "",
    ].join("\n"),
  );

  // CEO has full caps — read prompt, run shell (curl), reach network.
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
      "  builtin: [Read, Bash]",
      "  mcp: []",
      "capabilities: [filesystem:read, shell:execute, network:http, secrets:read_env]",
      "status: active",
      "---",
      "",
      "# CEO",
      "",
      "You delegate work. To delegate, run a single shell command:",
      "",
      "```",
      `curl -sS -X POST "${opsUrl}/mcp/e2e-ma/dispatch" \\`,
      `  -H "Authorization: Bearer ${opsToken}" \\`,
      `  -H "Content-Type: application/json" \\`,
      "  -d '{\"worker\":\"dev\",\"task\":{\"goal\":\"Write the literal string \\\"hello from dev\\\" into a file named dev-result.md at the project root.\",\"expected_outputs\":[\"dev-result.md\"]}}'",
      "```",
      "",
      "After the curl returns 200, your job is done.",
      "",
    ].join("\n"),
  );

  // Dev writes the artefact.
  await fs.writeFile(
    path.join(agentsDir, "dev.md"),
    [
      "---",
      'schema_version: "1.0"',
      "role: dev",
      'model: "claude-haiku-4-5"',
      "runner: hermes",
      "runner_type: ephemeral",
      "reports_to: ceo",
      "skills: []",
      "tools:",
      "  builtin: [Read, Write]",
      "  mcp: []",
      "capabilities: [filesystem:read, filesystem:write, shell:execute, secrets:read_env]",
      "status: active",
      "---",
      "",
      "# Dev",
      "",
      "You execute tasks delegated by the CEO. For each task, follow the goal precisely.",
      "When the goal is to write a file, create that file in the project root.",
      "",
    ].join("\n"),
  );
}

async function fileEventually(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(filePath, "utf8");
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

const { skip: skipE2E } = gateE2E();

test("E2E: CEO delegates to dev via dispatch endpoint (live LLM)", { skip: skipE2E, timeout: 240_000 }, async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "haex-ma-e2e-"));
  const slug = "e2e-ma";
  const queueCeo = path.join(projectRoot, ".specifyr", slug, "queue-ceo");
  const queueDev = path.join(projectRoot, ".specifyr", slug, "queue-dev");
  await fs.mkdir(queueCeo, { recursive: true });
  await fs.mkdir(queueDev, { recursive: true });

  // Token must be available BEFORE we build the org spec (the CEO's
  // prompt template embeds it as a literal). In production this is
  // injected via env, here we treat it as test-fixture data.
  const opsToken = "test-multi-agent-" + Math.random().toString(36).slice(2, 10);

  // We need the runtime to give us the dispatch server its slug + port.
  // Construct runtime first, then spawn the server with runtime as input,
  // THEN write the org with the resolved URL/token, THEN start runtime.
  const runtime = new CompanyRuntime({
    projectRoot,
    orgDir: path.join(projectRoot, ".specify", "org"),
    queueDirs: { ceo: queueCeo, dev: queueDev },
    slug,
    opsToken,
    runnerFactory: dockerRunnerFactory({
      projectRoot,
      // No `network` — use the default bridge so containers can hit
      // 172.17.0.1 (host gateway) where the test server listens.
      secretsResolver: (agent) => {
        if (!agent?.capabilities?.includes?.("secrets:read_env")) return undefined;
        const env = {
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          COMPANY_OPS_TOKEN: opsToken,
        };
        return env;
      },
    }),
  });

  let server;
  t.after(async () => {
    try {
      await runtime.stop();
    } catch {
      /* best effort */
    }
    try {
      if (server) await server.close();
    } catch {
      /* best effort */
    }
    spawnSync("docker", ["rm", "-f", ...runningContainersForSlug(slug)], { stdio: "ignore" });
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  // Spawn the test-only dispatch HTTP server. We need the URL to write
  // it into the CEO's prompt template (so the CEO's curl call hits it).
  server = await startDispatchServer({ runtime, expectedToken: opsToken });
  const opsUrl = server.url; // e.g. http://172.17.0.1:38421

  await writeMultiAgentOrg(projectRoot, opsUrl, opsToken);

  // Surface failures to stderr; multi-agent flows have many failure modes.
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
          2,
        ),
      );
    }
  });
  runtime.on("dispatch-error", (p) => {
    console.error("[dispatch-error]", p.path, p.error?.message ?? p.error);
  });

  await runtime.start();

  // Drop the CEO task. The CEO's prompt template already contains the
  // exact curl invocation, so the goal can be terse.
  await fs.writeFile(
    path.join(queueCeo, "delegate.yaml"),
    [
      'goal: "Delegate the dev-result.md write to the dev agent using the curl command in your role doc."',
      "",
    ].join("\n"),
  );

  // Wait for the dev artifact to land.
  const resultPath = path.join(projectRoot, "dev-result.md");
  const content = await fileEventually(resultPath, RESULT_TIMEOUT_MS);
  assert.ok(content !== null, `dev-result.md did not appear within ${RESULT_TIMEOUT_MS}ms`);
  assert.match(content, /hello from dev/i);
});
