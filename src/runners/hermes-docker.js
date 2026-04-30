/**
 * Hermes-Docker runner — spawns each agent in its own hermes-agent container.
 *
 * Mirrors HermesCliRunner's `execute(workItem, runtimeContext)` interface.
 * The difference: instead of `hermes chat -q` on the host, this runs
 *   `docker run [capability flags...] hermes-agent:dev`
 * The image's ENTRYPOINT (hermes-agent-entrypoint) selects whitelisted
 * binaries based on BINARY_WHITELIST and execs `hermes chat -q` inside.
 *
 * This runner is bound to a single agent at construction time (parallel to
 * HermesCliRunner's memoryRoot binding). The CompanyRuntime factory creates
 * one runner per agent at start().
 *
 * Capability-mapping errors (e.g. agent grants `docker:privileged` or caller
 * passes secrets without secrets:read_env) THROW rather than silently
 * falling back — those are config errors, not transient runtime failures.
 * Genuine runtime failures (docker daemon down, hermes crashes) DO fall back
 * to the parent HermesAgentRunner stub.
 */

import { HermesAgentRunner } from "./base.js";
import { runCommand } from "../utils/process.js";
import { capabilityFlags } from "./capability-to-docker.js";
import { hermesHomeForAgent } from "./hermes-paths.js";

function buildHermesPrompt(workItem, runtimeContext) {
  return [
    `You are executing a single scoped work item for slug '${runtimeContext.slug}'.`,
    `Pattern: ${runtimeContext.pattern.name}`,
    `Goal: ${workItem.goal}`,
    `Inputs: ${workItem.inputs.join(", ")}`,
    `Scope: ${workItem.scope.join(", ")}`,
    `Success criteria: ${workItem.successCriteria.join("; ")}`,
    `Expected outputs: ${workItem.expectedOutputs.join(", ")}`,
  ].join("\n");
}

/**
 * Build the `hermes chat` CLI argv for a single-shot run inside the
 * container. The prompt is passed as the `-q QUERY` value (NOT via stdin
 * — hermes 0.11 doesn't read stdin in single-query mode).
 *
 * Defaults applied:
 *   --provider anthropic        only ANTHROPIC_API_KEY is forwarded today
 *   -m anthropic/<agent.model>  unless agent.model already namespaced
 *   --max-turns 20              safety cap; runner_type:persistent doesn't
 *                               (yet) translate to unbounded turns
 *   --yolo                      skip hermes' own permission prompts; our
 *                               CapabilityApprovalService is the single
 *                               approval seam, double-prompting would be
 *                               surprising
 *   --ignore-user-config        the per-agent profile dir is the only
 *                               config source we trust
 */
function buildHermesChatArgs(prompt, agent) {
  const model = agent?.model ?? "claude-opus-4-5";
  const namespacedModel = model.includes("/") ? model : `anthropic/${model}`;
  return [
    "hermes",
    "chat",
    "--provider", "anthropic",
    "-m", namespacedModel,
    "--max-turns", "20",
    "--yolo",
    "--ignore-user-config",
    "-q", prompt,
  ];
}

const CONTAINER_NAME_SAFE = /[^a-zA-Z0-9_.-]/g;

/**
 * Default --user value for spawned containers: matches the host process's
 * uid:gid so bind-mount writes work even with --cap-drop=ALL stripping
 * CAP_DAC_OVERRIDE. Returns null on platforms without process.getuid()
 * (Windows) — caller can override with an explicit userId then.
 */
function defaultUserId() {
  if (typeof process.getuid !== "function") return null;
  const uid = process.getuid();
  const gid = process.getgid?.() ?? uid;
  return `${uid}:${gid}`;
}

export class HermesDockerRunner extends HermesAgentRunner {
  /**
   * @param {object} options
   * @param {object} options.agent           agent spec (role, capabilities, nix_packages)
   * @param {string} options.projectRoot     absolute host path; bind-mounted into container
   * @param {string} options.profileDir      absolute host path for HERMES_HOME
   * @param {string} [options.image]         container image tag, default 'hermes-agent:dev'
   * @param {string} [options.network]       compose network name
   * @param {Object<string,string>} [options.secrets]
   *                                         KV env vars; requires secrets:read_env grant
   * @param {string} [options.dockerCommand] docker binary, default 'docker'
   * @param {Function} [options.commandRunner]  DI for tests
   * @param {AgentRunner} [options.fallback]
   * @param {string|null} [options.userId]
   *                                         `--user UID[:GID]` value. Defaults
   *                                         to the host process's uid:gid on
   *                                         Linux (matches bind-mount owner
   *                                         so cap-dropped containers can
   *                                         still write). Pass `null` to
   *                                         omit and let the container run as
   *                                         the image's default USER (root).
   */
  constructor(options = {}) {
    super();
    this.name = "hermes-docker";
    if (!options.agent) throw new Error("HermesDockerRunner: agent required");
    if (!options.projectRoot) throw new Error("HermesDockerRunner: projectRoot required");
    if (!options.profileDir) throw new Error("HermesDockerRunner: profileDir required");

    this.agent = options.agent;
    this.projectRoot = options.projectRoot;
    this.profileDir = options.profileDir;
    this.binaryWhitelist = options.binaryWhitelist;
    this.image = options.image ?? "hermes-agent:dev";
    this.network = options.network;
    this.secrets = options.secrets;
    this.dockerCommand = options.dockerCommand ?? "docker";
    this.commandRunner = options.commandRunner ?? runCommand;
    this.fallback = options.fallback ?? new HermesAgentRunner();
    this.userId = options.userId === undefined ? defaultUserId() : options.userId;
  }

  async execute(workItem, runtimeContext) {
    if (!Array.isArray(workItem.scope) || workItem.scope.length === 0) {
      return this.fallback.execute(workItem, runtimeContext);
    }

    // Build the docker invocation. Capability-mapping errors propagate —
    // they indicate config drift, not transient failure.
    const flags = capabilityFlags({
      agent: this.agent,
      projectRoot: this.projectRoot,
      profileDir: this.profileDir,
      binaryWhitelist: this.binaryWhitelist,
      secrets: this.secrets,
      image: this.image,
      network: this.network,
      containerName: this.#containerNameFor(runtimeContext),
      userId: this.userId,
    });

    const prompt = buildHermesPrompt(workItem, runtimeContext);
    const cmdArgs = buildHermesChatArgs(prompt, this.agent);
    // capabilityFlags(...) places the image as its last entry; everything
    // after that is the container's CMD, which overrides the image's
    // default CMD. No stdin piping — hermes 0.11 reads -q QUERY from argv.
    const result = await this.commandRunner(
      this.dockerCommand,
      ["run", ...flags, ...cmdArgs],
      { cwd: runtimeContext.cwd }
    );

    // A non-zero docker exit means the container failed to start, hermes
    // crashed, or auth/model errors. Surface stderr so the dispatcher can
    // see the cause — falling back to a stub that returns
    // status:"completed" would hide a real failure (the silent-failure
    // pattern that wasted an E2E debugging cycle in inkrement 6).
    if (!result.ok) {
      return {
        status: "failed",
        summary: `hermes-docker exited ${result.code}: ${result.stderr.split("\n")[0] || "no stderr"}`,
        outputs: [],
        reviewStatus: "rejected",
        nextEvent: "investigate",
        metadata: {
          runner: this.name,
          provider: runtimeContext.provider.name,
          image: this.image,
          role: this.agent.role,
          exitCode: result.code,
        },
        transcript: result.stderr,
      };
    }

    return {
      status: "completed",
      summary:
        result.stdout.split("\n")[0] ||
        `Executed ${workItem.title} with hermes-docker (no stdout).`,
      outputs: workItem.expectedOutputs,
      reviewStatus: "accepted",
      nextEvent: "review_result",
      metadata: {
        runner: this.name,
        provider: runtimeContext.provider.name,
        image: this.image,
        role: this.agent.role,
      },
      transcript: result.stdout,
    };
  }

  #containerNameFor(runtimeContext) {
    const slug = String(runtimeContext?.slug ?? "x").replace(CONTAINER_NAME_SAFE, "_");
    const role = String(this.agent.role ?? "x").replace(CONTAINER_NAME_SAFE, "_");
    return `hermes-agent_${slug}_${role}`;
  }
}

/**
 * Factory for plugging the docker runner into CompanyRuntime.
 *
 * Returned function matches the runnerFactory signature expected by
 * CompanyRuntime: `(agent, runtimeMeta) => runner`.
 *
 * Image resolution precedence (highest first):
 *   1. `cfg.imageForRole(agent.role)`   (per-agent Nix-built image tag)
 *   2. `cfg.image`                      (single override for all agents)
 *   3. `process.env.HERMES_AGENT_IMAGE` (deploy-time override)
 *   4. `"hermes-agent:dev"`             (local-build default)
 *
 * @param {object} cfg
 * @param {string} cfg.projectRoot                       absolute host path
 * @param {(role: string) => string} [cfg.imageForRole]  per-agent image resolver
 * @param {string} [cfg.image]                           single image override
 * @param {string} [cfg.network]                         compose network name
 * @param {(agent) => Object<string,string>} [cfg.secretsResolver]
 * @returns {(agent, runtimeMeta) => HermesDockerRunner}
 */
export function dockerRunnerFactory({ projectRoot, imageForRole, image, network, secretsResolver }) {
  if (!projectRoot) throw new Error("dockerRunnerFactory: projectRoot required");
  return (agent, _runtimeMeta = {}) => {
    const profileDir = hermesHomeForAgent({ projectRoot, role: agent.role });
    const resolvedImage =
      (imageForRole ? imageForRole(agent.role) : null) ??
      image ??
      process.env.HERMES_AGENT_IMAGE ??
      "hermes-agent:dev";
    const secrets = secretsResolver ? secretsResolver(agent) : undefined;
    return new HermesDockerRunner({
      agent,
      projectRoot,
      profileDir,
      image: resolvedImage,
      network,
      secrets,
    });
  };
}
