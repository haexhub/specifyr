/**
 * Hermes-Docker runner — spawns each agent in its own hermes-agent container.
 *
 * Implements the HermesAgentRunner `execute(workItem, runtimeContext)` interface.
 * Instead of running `hermes chat -q` on the host, this runs
 *   `docker run [capability flags...] hermes-agent:dev`
 * The image's ENTRYPOINT (hermes-agent-entrypoint) selects whitelisted
 * binaries based on BINARY_WHITELIST and execs `hermes chat -q` inside.
 *
 * This runner is bound to a single agent at construction time (memoryRoot
 * is per-agent via the profileDir HERMES_HOME). The CompanyRuntime factory
 * creates one runner per agent at start().
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
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import path from "node:path";

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
 *                               NOTE: we intentionally do NOT use
 *                               --ignore-user-config: that flag would also
 *                               suppress $HERMES_HOME/config.yaml (the
 *                               pre-seeded per-agent profile at /profile),
 *                               causing the first-run wizard to fire in
 *                               non-interactive containers.
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
    // Persistent mode: container stays running between tasks; tasks run via docker exec.
    this.persistent = options.agent?.runner_type === "persistent";
    this.persistentContainerName = options.persistentContainerName ?? null;
    // Compose project/service for stack grouping. composeProject is the
    // sanitised project slug (set by the factory); composeService defaults to
    // the agent role, also sanitised so docker accepts it as a label value.
    this.composeProject = options.composeProject ?? null;
    this.composeService = options.composeService
      ?? (options.agent?.role
        ? String(options.agent.role).replace(CONTAINER_NAME_SAFE, "_")
        : null);
  }

  /**
   * Start the persistent container if this runner is in persistent mode.
   * No-op for ephemeral runners. Idempotent — safe to call if already running.
   */
  async startPersistent() {
    if (!this.persistent || !this.persistentContainerName) return;

    // Check if container already running.
    const check = await this.commandRunner(
      this.dockerCommand,
      ["inspect", "--format", "{{.State.Running}}", this.persistentContainerName],
      {}
    );
    if (check.ok && check.stdout.trim() === "true") return;

    // Remove stale stopped container (same name) if present.
    await this.commandRunner(
      this.dockerCommand, ["rm", "-f", this.persistentContainerName], {}
    ).catch(() => {});

    const flags = capabilityFlags({
      agent: this.agent,
      projectRoot: this.projectRoot,
      profileDir: this.profileDir,
      binaryWhitelist: this.binaryWhitelist,
      secrets: this.secrets,
      image: this.image,
      network: this.network,
      containerName: this.persistentContainerName,
      composeProject: this.composeProject,
      composeService: this.composeService,
      userId: this.userId,
      remove: false,
    });

    // Start container idling — tasks arrive via docker exec. `sleep infinity`
    // is provided by coreutils, which the agent-image-builder always bundles
    // as a baseline package. The hermes Nix closure does ship Python, but
    // python3 is not exposed on PATH (only the hermes wrapper is), so we use
    // sleep instead.
    const result = await this.commandRunner(
      this.dockerCommand,
      ["run", "-d", ...flags, "sleep", "infinity"],
      {}
    );
    if (!result.ok) {
      throw new Error(
        `HermesDockerRunner: failed to start persistent container '${this.persistentContainerName}': ${result.stderr || result.stdout}`
      );
    }
  }

  /** Stop and remove the persistent container. No-op for ephemeral runners. */
  async stopPersistent() {
    if (!this.persistent || !this.persistentContainerName) return;
    await this.commandRunner(
      this.dockerCommand, ["rm", "-f", this.persistentContainerName], {}
    ).catch(() => {});
  }

  async execute(workItem, runtimeContext) {
    if (!Array.isArray(workItem.scope) || workItem.scope.length === 0) {
      return this.fallback.execute(workItem, runtimeContext);
    }
    return this.persistent
      ? this.#executePersistent(workItem, runtimeContext)
      : this.#executeEphemeral(workItem, runtimeContext);
  }

  /** Run hermes inside the already-running persistent container via docker exec. */
  async #executePersistent(workItem, runtimeContext) {
    const prompt = buildHermesPrompt(workItem, runtimeContext);
    const cmdArgs = buildHermesChatArgs(prompt, this.agent);
    const result = await this.commandRunner(
      this.dockerCommand,
      ["exec", this.persistentContainerName, ...cmdArgs],
      { cwd: runtimeContext.cwd }
    );

    if (!result.ok) {
      const detail = result.stderr || result.stdout;
      return {
        status: "failed",
        summary: `hermes-docker-persistent exited ${result.code}: ${detail.split("\n")[0] || "no output"}`,
        outputs: [],
        reviewStatus: "rejected",
        nextEvent: "investigate",
        metadata: { runner: this.name, provider: runtimeContext.provider.name, image: this.image, role: this.agent.role, exitCode: result.code },
        transcript: detail,
      };
    }
    return {
      status: "completed",
      summary: result.stdout.split("\n")[0] || `Executed ${workItem.title} (persistent).`,
      outputs: workItem.expectedOutputs,
      reviewStatus: "accepted",
      nextEvent: "review_result",
      metadata: { runner: this.name, provider: runtimeContext.provider.name, image: this.image, role: this.agent.role },
      transcript: result.stdout,
    };
  }

  /** One-shot container per task — original ephemeral behaviour. */
  async #executeEphemeral(workItem, runtimeContext) {
    // Delete stale auth.json so hermes re-reads credentials from injected env vars.
    // auth.json is a credential cache — without deletion hermes reuses the cached
    // OAuth token even when a different key is injected via -e flags.
    try { unlinkSync(path.join(this.profileDir, "auth.json")); } catch { /* may not exist */ }

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
      composeProject: this.composeProject ?? this.#composeProjectFor(runtimeContext),
      composeService: this.composeService,
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
      // Hermes prints config errors to stdout, not stderr. Use whichever is non-empty.
      const detail = result.stderr || result.stdout;
      return {
        status: "failed",
        summary: `hermes-docker exited ${result.code}: ${detail.split("\n")[0] || "no output"}`,
        outputs: [],
        reviewStatus: "rejected",
        nextEvent: "investigate",
        metadata: { runner: this.name, provider: runtimeContext.provider.name, image: this.image, role: this.agent.role, exitCode: result.code },
        transcript: detail,
      };
    }

    return {
      status: "completed",
      summary: result.stdout.split("\n")[0] || `Executed ${workItem.title} with hermes-docker (no stdout).`,
      outputs: workItem.expectedOutputs,
      reviewStatus: "accepted",
      nextEvent: "review_result",
      metadata: { runner: this.name, provider: runtimeContext.provider.name, image: this.image, role: this.agent.role },
      transcript: result.stdout,
    };
  }

  #containerNameFor(runtimeContext) {
    const slug = String(runtimeContext?.slug ?? "x").replace(CONTAINER_NAME_SAFE, "_");
    const role = String(this.agent.role ?? "x").replace(CONTAINER_NAME_SAFE, "_");
    const suffix = randomBytes(4).toString("hex");
    return `hermes-agent_${slug}_${role}_${suffix}`;
  }

  // Fallback when no composeProject was injected at construction (e.g. tests
  // that build the runner directly). Derives the slug from runtimeContext so
  // the stack label is still consistent with the container name.
  #composeProjectFor(runtimeContext) {
    if (runtimeContext?.slug == null) return null;
    return String(runtimeContext.slug).replace(CONTAINER_NAME_SAFE, "_");
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
  return (agent, runtimeMeta = {}) => {
    const profileDir = hermesHomeForAgent({ projectRoot, role: agent.role });
    const resolvedImage =
      (imageForRole ? imageForRole(agent.role) : null) ??
      image ??
      process.env.HERMES_AGENT_IMAGE ??
      "hermes-agent:dev";
    const secrets = secretsResolver ? secretsResolver(agent) : undefined;
    const rawBinaries = agent?.tools?.binaries ?? [];
    const catalog = runtimeMeta?.catalog;
    const binaryWhitelist = rawBinaries.includes("*") && catalog
      ? [...catalog.binaries.keys()]
      : rawBinaries.length > 0 ? rawBinaries : undefined;

    // Persistent agents get a stable container name (no random suffix) so
    // docker exec can always target the same running container.
    const slug = String(runtimeMeta?.slug ?? "agent").replace(CONTAINER_NAME_SAFE, "_");
    const role = String(agent?.role ?? "x").replace(CONTAINER_NAME_SAFE, "_");
    const persistentContainerName = agent?.runner_type === "persistent"
      ? `hermes-persistent_${slug}_${role}`
      : null;

    return new HermesDockerRunner({
      agent,
      projectRoot,
      profileDir,
      image: resolvedImage,
      network,
      secrets,
      binaryWhitelist,
      persistentContainerName,
      composeProject: slug,
      composeService: role,
    });
  };
}
