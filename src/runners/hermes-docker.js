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
import { resolveBinariesForAgent } from "../core/catalog-loader.js";

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

export class HermesDockerRunner extends HermesAgentRunner {
  /**
   * @param {object} options
   * @param {object} options.agent           agent spec (role, capabilities, tools.binaries)
   * @param {string} options.projectRoot     absolute host path; bind-mounted into container
   * @param {string} options.profileDir      absolute host path for HERMES_HOME
   * @param {string[]} [options.binaryWhitelist]
   *                                         catalog binary IDs (post wildcard expansion)
   * @param {string} [options.image]         container image tag, default 'hermes-agent:dev'
   * @param {string} [options.network]       compose network name
   * @param {Object<string,string>} [options.secrets]
   *                                         KV env vars; requires secrets:read_env grant
   * @param {string} [options.dockerCommand] docker binary, default 'docker'
   * @param {Function} [options.commandRunner]  DI for tests
   * @param {AgentRunner} [options.fallback]
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
    });

    const prompt = buildHermesPrompt(workItem, runtimeContext);
    const cmdArgs = buildHermesChatArgs(prompt, this.agent);
    // capabilityFlags(...) places the image as its last entry; everything
    // after that is the container's CMD, which overrides the image's
    // default CMD. We drop `-i` (no stdin piping any more) and rely on
    // single-shot `-q QUERY` semantics.
    const result = await this.commandRunner(
      this.dockerCommand,
      ["run", ...flags, ...cmdArgs],
      { cwd: runtimeContext.cwd }
    );

    if (!result.ok || !result.stdout) {
      return this.fallback.execute(workItem, runtimeContext);
    }

    return {
      status: "completed",
      summary:
        result.stdout.split("\n")[0] ??
        `Executed ${workItem.title} with hermes-docker.`,
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
 * CompanyRuntime: `(agent, runtimeMeta) => runner`. The second argument
 * carries runtime-loaded context (currently `catalog`) that wasn't
 * available at factory-construction time.
 *
 * Image resolution precedence (highest first):
 *   1. explicit `cfg.image`            (caller wired a specific tag)
 *   2. `process.env.HERMES_AGENT_IMAGE` (deploy-time override; e.g. compose
 *                                       sets this to a GHCR pin in prod)
 *   3. `"hermes-agent:dev"`             (local-build fallback)
 *
 * @param {object} cfg
 * @param {string} cfg.projectRoot               absolute host path
 * @param {string} [cfg.image]                   container image tag
 * @param {string} [cfg.network]                 compose network name
 * @param {(agent) => Object<string,string>} [cfg.secretsResolver]
 *                                                per-agent secret resolution;
 *                                                returned KV map is passed
 *                                                through to capabilityFlags()
 *                                                which will throw if the
 *                                                agent lacks secrets:read_env
 * @returns {(agent, runtimeMeta) => HermesDockerRunner}
 */
export function dockerRunnerFactory({ projectRoot, image, network, secretsResolver }) {
  if (!projectRoot) throw new Error("dockerRunnerFactory: projectRoot required");
  const resolvedImage = image ?? process.env.HERMES_AGENT_IMAGE ?? "hermes-agent:dev";
  return (agent, runtimeMeta = {}) => {
    const profileDir = hermesHomeForAgent({ projectRoot, role: agent.role });
    const catalog = runtimeMeta.catalog;
    const binaryWhitelist = catalog
      ? resolveBinariesForAgent(agent, catalog).map((spec) => spec.id)
      : agent?.tools?.binaries; // raw passthrough; wildcards stay unexpanded
    const secrets = secretsResolver ? secretsResolver(agent) : undefined;
    return new HermesDockerRunner({
      agent,
      projectRoot,
      profileDir,
      binaryWhitelist,
      image: resolvedImage,
      network,
      secrets,
    });
  };
}
