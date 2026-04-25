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
 *      CEO is expected to call back via the firma-ops MCP server.
 *   3. stop(): stop the queue-poller, signal CEO to drain, await teardown.
 *
 * NB: This module does not directly enforce capability-gate for tool calls
 * happening inside the Hermes process (Hermes is opaque). The gate is enforced
 * in the firma-ops MCP server, which sits between the Hermes-resident CEO and
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

export class CompanyRuntime extends EventEmitter {
  constructor({ projectRoot, orgDir, queueDir, runnerFactory, hermesBinary = "hermes" } = {}) {
    super();
    if (!projectRoot) throw new Error("CompanyRuntime: projectRoot required");
    if (!orgDir) throw new Error("CompanyRuntime: orgDir required");
    if (!queueDir) throw new Error("CompanyRuntime: queueDir required");
    this.projectRoot = projectRoot;
    this.orgDir = orgDir;
    this.queueDir = queueDir;
    this.hermesBinary = hermesBinary;
    this.runnerFactory =
      runnerFactory ?? defaultRunnerFactory({ projectRoot, hermesBinary });
    this.runners = new Map(); // role -> runner
    this.poller = null;
    this.worktrees = new WorktreeManager({ repoRoot: projectRoot });
    this.company = null;
  }

  async start() {
    this.company = await loadCompany(this.orgDir);
    if (!this.company.constitution) {
      throw new Error("CompanyRuntime: missing constitution.md in orgDir");
    }
    if (this.company.agents.size === 0) {
      throw new Error("CompanyRuntime: no agents loaded");
    }

    // Provision per-agent Hermes profile dirs (lazy-create; Hermes initializes on first use).
    for (const agent of this.company.agents.values()) {
      const home = hermesHomeForAgent({ projectRoot: this.projectRoot, role: agent.role });
      await mkdir(home, { recursive: true });
      this.runners.set(agent.role, this.runnerFactory(agent));
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
   * firma-ops MCP server has a single entry point.
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
}

function defaultRunnerFactory({ projectRoot, hermesBinary }) {
  return (agent) =>
    new HermesCliRunner({
      command: hermesBinary,
      memoryRoot: hermesHomeForAgent({ projectRoot, role: agent.role }),
    });
}
