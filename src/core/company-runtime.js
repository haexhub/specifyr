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
import { mkdir } from "node:fs/promises";
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
    this.runnerFactory =
      runnerFactory ?? defaultRunnerFactory({ projectRoot, hermesBinary });
    this.runners = new Map(); // role -> runner
    this.poller = null;
    this.worktrees = new WorktreeManager({ repoRoot: projectRoot });
    this.company = null;
    this.catalog = null;
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
    this.poller.on("task", (evt) => this.emit("task", evt));
    this.poller.on("task-removed", (evt) => this.emit("task-removed", evt));
    this.poller.on("error", (err) => this.emit("error", err));
    await this.poller.start();
    this.emit("started", { agents: [...this.company.agents.keys()] });
  }

  async stop() {
    if (this.poller) await this.poller.stop();
    this.poller = null;
    this.runners.clear();
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
