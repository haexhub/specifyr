/**
 * CompanyRuntime — composes spec-loader, capability-gate, queue-poller,
 * worktree-manager, and the Hermes runners into a runnable "company" instance.
 *
 * This is the entry-point invoked by the `/speckit.company.start` slash
 * command (via the new `/api/projects/<slug>/company/start` server endpoint).
 *
 * Lifecycle:
 *   1. start(): load org-spec, prepare per-agent Hermes profile dirs,
 *      register a runner per agent, start queue polling.
 *   2. on queue 'task' event: dispatch to CEO with task as input;
 *      CEO is expected to call back via the company-ops MCP server.
 *   3. stop(): stop the queue-poller, signal CEO to drain, await teardown.
 *
 * NB: This module does not directly enforce capability-gate for tool calls
 * happening inside the Hermes process (Hermes is opaque). The gate is enforced
 * in the company-ops MCP server, which sits between the Hermes-resident CEO and
 * any downstream dispatch. CompanyRuntime exposes capability-gate as a utility
 * for that MCP server to call.
 */

import path from "node:path";
import { mkdir, unlink } from "node:fs/promises";
import { EventEmitter } from "node:events";

import { loadCompany } from "../agents/spec-loader.js";
import { QueuePoller } from "./queue-poller.js";
import { WorktreeManager } from "./worktree-manager.js";
import { HermesCliRunner } from "../runners/hermes-cli.js";
import { hermesHomeForAgent } from "../runners/hermes-paths.js";
import { checkCapability } from "./capability-gate.js";
import {
  loadCatalog,
  resolveToolsForAgent,
  resolveSkillsForAgent,
  resolveBinariesForAgent,
  validateCatalogReferences,
} from "./catalog-loader.js";

export class CompanyRuntime extends EventEmitter {
  constructor({
    projectRoot,
    orgDir,
    queueDir,
    runnerFactory,
    hermesBinary = "hermes",
    catalogDir,
    slug,
    ceoRole = "ceo",
  } = {}) {
    super();
    if (!projectRoot) throw new Error("CompanyRuntime: projectRoot required");
    if (!orgDir) throw new Error("CompanyRuntime: orgDir required");
    if (!queueDir) throw new Error("CompanyRuntime: queueDir required");
    this.projectRoot = projectRoot;
    this.orgDir = orgDir;
    this.queueDir = queueDir;
    this.catalogDir = catalogDir; // optional; if set, references are resolved & validated
    this.hermesBinary = hermesBinary;
    // slug for runtimeContext; defaults to <queueDir parent>'s name —
    // queueDir convention is `<root>/.specops/<slug>/queue/`.
    this.slug = slug ?? path.basename(path.dirname(queueDir));
    this.ceoRole = ceoRole;
    this.runnerFactory =
      runnerFactory ?? defaultRunnerFactory({ projectRoot, hermesBinary });
    this.runners = new Map(); // role -> runner
    this.poller = null;
    this.worktrees = new WorktreeManager({ repoRoot: projectRoot });
    this.company = null;
    this.catalog = null;
    // Dispatch state (queue → runner). Serial FIFO: one task at a time
    // because the CEO is `runner_type: persistent` and we don't want
    // concurrent containers stepping on each other for the same project.
    this._dispatchQueue = [];
    this._dispatching = false;
    this._inFlightPaths = new Set(); // dedup re-fires while a path is processing
  }

  async start() {
    this.company = await loadCompany(this.orgDir);
    if (!this.company.constitution) {
      throw new Error("CompanyRuntime: missing constitution.md in orgDir");
    }
    if (this.company.agents.size === 0) {
      throw new Error("CompanyRuntime: no agents loaded");
    }

    // Load central tool/skill catalog if configured. Errors here block startup
    // because dangling references would crash the runtime later anyway.
    if (this.catalogDir) {
      this.catalog = await loadCatalog(this.catalogDir);
      const findings = validateCatalogReferences([...this.company.agents.values()], this.catalog);
      const errors = findings.filter((f) => f.severity === "error");
      if (errors.length > 0) {
        throw new Error(
          `CompanyRuntime: catalog reference errors:\n${errors
            .map((f) => `  ${f.code}: ${f.message}`)
            .join("\n")}`
        );
      }
    }

    // Provision per-agent Hermes profile dirs (lazy-create; Hermes initializes on first use).
    // The runnerFactory receives runtime-loaded context as its second arg —
    // currently the catalog, so docker runners can resolve binary wildcards.
    // Default factories that take only `agent` ignore the second arg safely.
    for (const agent of this.company.agents.values()) {
      const home = hermesHomeForAgent({ projectRoot: this.projectRoot, role: agent.role });
      await mkdir(home, { recursive: true });
      this.runners.set(agent.role, this.runnerFactory(agent, { catalog: this.catalog }));
    }

    // Queue polling: emits 'task' for every yaml dropped in queueDir.
    this.poller = new QueuePoller({ queueDir: this.queueDir });
    this.poller.on("task", (evt) => {
      this.emit("task", evt);
      this._enqueueDispatch(evt);
    });
    this.poller.on("task-removed", (evt) => this.emit("task-removed", evt));
    this.poller.on("error", (err) => this.emit("error", err));
    await this.poller.start();
    this.emit("started", { agents: [...this.company.agents.keys()] });
  }

  /**
   * Enqueue a task event for dispatch. Drops re-fires for a path that's
   * already processing or queued (chokidar can fire multiple add/change
   * events for the same write).
   */
  _enqueueDispatch(evt) {
    if (this._inFlightPaths.has(evt.path)) return;
    this._inFlightPaths.add(evt.path);
    this._dispatchQueue.push(evt);
    this._processNextDispatch();
  }

  async _processNextDispatch() {
    if (this._dispatching) return;
    if (this._dispatchQueue.length === 0) return;
    if (!this.poller) return; // stopped
    this._dispatching = true;
    const evt = this._dispatchQueue.shift();
    try {
      await this._dispatchToCEO(evt);
    } catch (err) {
      this.emit("dispatch-error", { path: evt.path, error: err });
    } finally {
      this._inFlightPaths.delete(evt.path);
      this._dispatching = false;
      // Process the next entry, if any.
      this._processNextDispatch();
    }
  }

  /**
   * Hand a parsed task off to the CEO runner. The CEO is configured via
   * `ceoRole` (default "ceo"). On `status === "completed"`, the queue YAML
   * is removed; on failure it's left in place so the next start picks it
   * up again (simple retry-on-restart semantic).
   */
  async _dispatchToCEO(evt) {
    const runner = this.runners.get(this.ceoRole);
    if (!runner) {
      this.emit("dispatch-error", {
        path: evt.path,
        error: new Error(`No runner for role '${this.ceoRole}'; cannot dispatch`),
      });
      return;
    }
    if (typeof runner.execute !== "function") {
      // Stub runner from tests: just record dispatch attempt and bail.
      this.emit("dispatched", { path: evt.path, role: this.ceoRole, result: null });
      return;
    }

    const workItem = adaptTaskToWorkItem(evt.task, evt.path);
    const runtimeContext = {
      slug: this.slug,
      cwd: this.projectRoot,
      pattern: { name: "company" },
      provider: { name: "anthropic" },
    };

    this.emit("dispatch-started", { path: evt.path, role: this.ceoRole, workItem });
    const result = await runner.execute(workItem, runtimeContext);
    this.emit("dispatched", { path: evt.path, role: this.ceoRole, result });

    if (result?.status === "completed") {
      try {
        await unlink(evt.path);
      } catch (err) {
        // Already deleted by another consumer or never existed — non-fatal.
        if (err?.code !== "ENOENT") {
          this.emit("dispatch-error", { path: evt.path, error: err });
        }
      }
    }
  }

  async stop() {
    if (this.poller) await this.poller.stop();
    this.poller = null;
    this.runners.clear();
    // Drop pending dispatches; in-flight executions race their own runner
    // teardown. Callers should `await stop()` after `await runtime.start()`
    // returns idle, but if a dispatch is mid-execute() the runner's own
    // commandRunner timeout governs cleanup.
    this._dispatchQueue.length = 0;
    this._inFlightPaths.clear();
    this.emit("stopped");
  }

  /**
   * Authorize a tool/capability use by an agent. Wraps capability-gate so the
   * company-ops MCP server has a single entry point.
   */
  authorize({ role, capability, taskAutonomy }) {
    const agent = this.company?.agents.get(role);
    if (!agent) {
      return { allowed: false, reason: `unknown role '${role}'`, requiresApproval: false };
    }
    return checkCapability({ agent, request: capability, taskAutonomy });
  }

  /**
   * Look up an agent spec by role.
   */
  getAgent(role) {
    return this.company?.agents.get(role) ?? null;
  }

  listAgents() {
    return this.company ? [...this.company.agents.values()] : [];
  }

  /**
   * Snapshot for status endpoints. Returns "running" only when the poller
   * is live; once stop() runs it flips to "stopped". `queueDepth` is the
   * number of task YAMLs sitting in the queue dir at call time.
   */
  getStatus() {
    return {
      status: this.poller ? "running" : "stopped",
      agents: this.listAgents().map((a) => ({
        role: a.role,
        capabilities: a.capabilities,
        resources: a.resources ?? null,
      })),
      queueDepth: this.poller ? this.poller.getPendingCount() : 0,
    };
  }

  /**
   * Resolve an agent's `tools.mcp` references against the loaded catalog.
   * @returns {ToolSpec[]} hydrated specs
   */
  getResolvedTools(role) {
    const agent = this.getAgent(role);
    if (!agent) return [];
    if (!this.catalog) return []; // no catalog → no resolution
    return resolveToolsForAgent(agent, this.catalog);
  }

  /**
   * Resolve an agent's `skills` references against the loaded catalog.
   * @returns {SkillSpec[]} hydrated specs (each has a markdown body)
   */
  getResolvedSkills(role) {
    const agent = this.getAgent(role);
    if (!agent) return [];
    if (!this.catalog) return [];
    return resolveSkillsForAgent(agent, this.catalog);
  }

  /**
   * Resolve an agent's `tools.binaries` references against the loaded catalog.
   * @returns {BinarySpec[]} hydrated specs
   */
  getResolvedBinaries(role) {
    const agent = this.getAgent(role);
    if (!agent) return [];
    if (!this.catalog) return [];
    return resolveBinariesForAgent(agent, this.catalog);
  }
}

function defaultRunnerFactory({ projectRoot, hermesBinary }) {
  return (agent) =>
    new HermesCliRunner({
      command: hermesBinary,
      memoryRoot: hermesHomeForAgent({ projectRoot, role: agent.role }),
    });
}

/**
 * Adapt a parsed queue YAML into a workItem that satisfies the runner
 * contract. `scope` is the load-bearing field for HermesAgentRunner — an
 * empty scope causes the runner to bail with "no explicit scope, blocked
 * for safety". We default to ["ALL"] for tasks without explicit scope so
 * the dispatcher actually drives execution; callers can still constrain
 * with an explicit `scope:` field in their YAML.
 */
export function adaptTaskToWorkItem(task, taskPath) {
  const safe = task ?? {};
  const fallbackTitle = path.basename(taskPath ?? "task.yaml", ".yaml");
  return {
    title: safe.title ?? fallbackTitle,
    goal: safe.goal ?? "(no goal specified)",
    inputs: Array.isArray(safe.inputs) ? safe.inputs : [],
    scope:
      Array.isArray(safe.scope) && safe.scope.length > 0
        ? safe.scope
        : ["ALL"],
    successCriteria: Array.isArray(safe.success_criteria)
      ? safe.success_criteria
      : Array.isArray(safe.successCriteria)
        ? safe.successCriteria
        : [],
    expectedOutputs: Array.isArray(safe.expected_outputs)
      ? safe.expected_outputs
      : Array.isArray(safe.expectedOutputs)
        ? safe.expectedOutputs
        : [],
  };
}
