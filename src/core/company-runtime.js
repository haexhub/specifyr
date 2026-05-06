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
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";

import { loadCompany } from "../agents/spec-loader.js";
import { QueuePoller } from "./queue-poller.js";
import { WorktreeManager } from "./worktree-manager.js";
import { HermesAgentRunner } from "../runners/base.js";
import { hermesHomeForAgent } from "../runners/hermes-paths.js";
import { checkCapability } from "./capability-gate.js";
import { CapabilityApprovalService } from "./capability-approval-service.js";
import {
  loadCatalog,
  resolveToolsForAgent,
  resolveSkillsForAgent,
  resolveBinariesForAgent,
  validateCatalogReferences,
} from "./catalog-loader.js";
import { CompanyEventLog } from "./company-event-log.js";
import { CompanyEventIndex } from "./company-event-index.js";
import { Supervisor } from "./supervisor.js";

export class CompanyRuntime extends EventEmitter {
  constructor({
    projectRoot,
    hostProjectRoot,
    orgDir,
    queueDirs,
    runnerFactory,
    hermesBinary = "hermes",
    catalogDir,
    slug,
    ceoRole = "ceo",
    approvalService,
    opsToken,
    eventLog,
    supervisor,
  } = {}) {
    super();
    if (!projectRoot) throw new Error("CompanyRuntime: projectRoot required");
    if (!orgDir) throw new Error("CompanyRuntime: orgDir required");
    if (!queueDirs || typeof queueDirs !== "object" || Array.isArray(queueDirs)) {
      throw new Error("CompanyRuntime: queueDirs map required ({ [role]: dir })");
    }
    if (Object.keys(queueDirs).length === 0) {
      throw new Error("CompanyRuntime: queueDirs must contain at least one entry");
    }
    if (!queueDirs[ceoRole]) {
      throw new Error(`CompanyRuntime: queueDirs missing entry for ceoRole '${ceoRole}'`);
    }
    this.projectRoot = projectRoot;
    // hostProjectRoot: used for file ops on the host filesystem (profile provisioning).
    // In containerized setups, projectRoot is the container-side path (/data/projects/…)
    // while the Nitro server process runs on the host where that path doesn't exist.
    // Falls back to projectRoot for non-containerized setups (tests, local dev).
    this.hostProjectRoot = hostProjectRoot ?? projectRoot;
    this.orgDir = orgDir;
    this.queueDirs = { ...queueDirs };
    this.catalogDir = catalogDir; // optional; if set, references are resolved & validated
    this.hermesBinary = hermesBinary;
    // slug for runtimeContext; defaults to CEO queue's grandparent dir —
    // convention is `<root>/.specifyr/<slug>/queue-<role>/`.
    this.slug = slug ?? path.basename(path.dirname(queueDirs[ceoRole]));
    this.ceoRole = ceoRole;
    this.runnerFactory =
      runnerFactory ?? defaultRunnerFactory({ projectRoot, hermesBinary });
    this.runners = new Map(); // role -> runner
    this.pollers = new Map(); // role -> QueuePoller
    this.worktrees = new WorktreeManager({ repoRoot: projectRoot });
    this.company = null;
    this.catalog = null;
    // ApprovalService is owned by the runtime so callers (notably the
    // future company-ops MCP server) have a single composition seam to
    // request capability approvals. Injectable for tests; default is a
    // fresh service with the NoopTransport stub.
    this.approvalService = approvalService ?? new CapabilityApprovalService();
    // Per-runtime bearer token, used by the company-ops MCP server to
    // authenticate worker-container callbacks. Generated at construction
    // so it's available immediately for testing; rotated by stop+start.
    // 32 random bytes → 64-char hex; sufficient entropy for a non-public
    // single-host service. Override-able via constructor for deterministic
    // tests.
    this.opsToken = opsToken ?? randomBytes(32).toString("hex");
    // Per-runtime SQLite read-index for the event log. Lives at
    // `<projectRoot>/.specifyr/<slug>/state.db`. JSONL is the canonical
    // source of truth; this index is rebuildable from it (see
    // architecture_decisions.md §3). Opened in start(), closed in stop().
    const specifyrDir = path.join(projectRoot, ".specifyr", this.slug);
    this.eventIndex = new CompanyEventIndex({
      dbPath: path.join(specifyrDir, "state.db"),
    });
    // Per-runtime event log (JSONL, per-day rotation). Default writes under
    // `<projectRoot>/.specifyr/<slug>/events/`. Write-through into eventIndex
    // for fast queries; tests can inject a stub log.
    this.eventLog =
      eventLog ??
      new CompanyEventLog({
        baseDir: specifyrDir,
        index: this.eventIndex,
      });
    // Supervisor is the deterministic watchdog that consumes the event
    // log + runtime events to detect stuck dispatches. Pass `supervisor:
    // null` to disable (e.g. for tests that don't want a background
    // timer). Auto-instantiated otherwise; lifecycle is bound to start()/
    // stop() below.
    this.supervisor =
      supervisor === null
        ? null
        : (supervisor ?? new Supervisor({ runtime: this, eventLog: this.eventLog }));
    // Dispatch state — per-role serial FIFO, but roles run concurrently.
    // Each agent container is isolated (own profile dir, own Docker
    // container), so two roles can be mid-execute without stepping on
    // each other. Within a role we stay serial because (a) `runner_type:
    // persistent` agents must not have two concurrent containers for the
    // same project, and (b) ordering inside a single role's queue is a
    // useful default — we want "fix bug A, then fix bug B" to actually
    // happen in that order.
    this._dispatchQueues = new Map(); // role -> [{path, task, role}]
    this._dispatching = new Map(); // role -> boolean
    this._inFlightPaths = new Set(); // dedup re-fires across all roles (paths are unique)
    // Set on start(), cleared on stop(). The UI uses this to filter "live"
    // failures (since current session) from the historical event log.
    this.startedAt = null;
  }

  async start() {
    // Open the SQLite index up-front. If the file is missing or the schema
    // is empty, open() creates it; if the JSONL log already has events from
    // a prior run, replay them so the index is consistent before any new
    // event lands. rebuildFromDisk is idempotent (INSERT OR IGNORE on id).
    this.eventIndex.open();
    this.eventIndex.rebuildFromDisk(path.join(this.projectRoot, ".specifyr", this.slug));

    this.company = await loadCompany(this.orgDir);
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

    // Validate: every agent role must have a queueDir entry, otherwise tasks
    // dropped for that role would be silently lost (no poller, no dispatch).
    // Extra queueDirs entries that don't map to an active agent are tolerated
    // and simply skipped — harmless leftover config.
    for (const role of this.company.agents.keys()) {
      if (!this.queueDirs[role]) {
        throw new Error(`CompanyRuntime: agent role '${role}' has no queueDirs entry`);
      }
    }

    // Provision per-agent Hermes profile dirs. Pre-seed config.yaml so the
    // hermes setup wizard doesn't trigger in non-interactive containers
    // (older versions exit 1 when no provider is configured and there's no TTY).
    // Delete auth.json on every start: hermes caches credentials with their own
    // base_url, which can point to api.anthropic.com instead of the proxy after
    // a token refresh. Deleting forces hermes to re-read ANTHROPIC_API_KEY and
    // ANTHROPIC_BASE_URL from env vars and store the proxy URL correctly.
    for (const agent of this.company.agents.values()) {
      const home = hermesHomeForAgent({ projectRoot: this.projectRoot, role: agent.role });
      await mkdir(home, { recursive: true });
      try {
        await writeFile(
          path.join(home, "config.yaml"),
          "model:\n  provider: anthropic\n",
          { flag: "wx" }
        );
      } catch { /* already exists — preserve existing config */ }
      try { await unlink(path.join(home, "auth.json")); } catch { /* OK if missing */ }
      this.runners.set(agent.role, this.runnerFactory(agent, { catalog: this.catalog, slug: this.slug }));
    }

    // Start persistent containers before polling begins so they are ready
    // to receive docker exec calls the moment the first task arrives.
    for (const runner of this.runners.values()) {
      if (typeof runner.startPersistent === "function") {
        await runner.startPersistent();
      }
    }

    // One QueuePoller per active agent role. Each poller emits 'task'
    // independently; we tag the event with `role` before re-emitting /
    // enqueueing, so the dispatcher knows which runner to invoke.
    for (const role of this.company.agents.keys()) {
      const dir = this.queueDirs[role];
      const poller = new QueuePoller({ queueDir: dir });
      poller.on("task", (evt) => {
        const tagged = { ...evt, role };
        this.emit("task", tagged);
        this._enqueueDispatch(tagged);
      });
      poller.on("task-removed", (evt) => this.emit("task-removed", { ...evt, role }));
      poller.on("error", (err) => this.emit("error", err));
      await poller.start();
      this.pollers.set(role, poller);
    }
    // Supervisor must subscribe AFTER pollers exist (so it can observe the
    // dispatch-started events from the runtime) but BEFORE we declare
    // 'started' so the watchdog is live the moment the first task arrives.
    if (this.supervisor) {
      this.supervisor.start();
    }
    this.startedAt = new Date().toISOString();
    this.emit("started", { agents: [...this.company.agents.keys()] });
  }

  /**
   * Enqueue a task event for dispatch. Drops re-fires for a path that's
   * already processing or queued (chokidar can fire multiple add/change
   * events for the same write). Routes into the per-role queue; the
   * dispatcher for that role drains independently of other roles.
   */
  _enqueueDispatch(evt) {
    if (this._inFlightPaths.has(evt.path)) return;
    this._inFlightPaths.add(evt.path);
    if (!this._dispatchQueues.has(evt.role)) {
      this._dispatchQueues.set(evt.role, []);
    }
    this._dispatchQueues.get(evt.role).push(evt);
    this._processNextDispatch(evt.role);
  }

  /**
   * Drain the next task from one role's queue. Concurrent calls for the
   * SAME role are no-ops (the in-flight call will recurse on completion);
   * concurrent calls for DIFFERENT roles run in parallel — that's the
   * whole point of 8.2.
   */
  async _processNextDispatch(role) {
    if (this._dispatching.get(role)) return;
    const queue = this._dispatchQueues.get(role);
    if (!queue || queue.length === 0) return;
    if (this.pollers.size === 0) return; // stopped
    const evt = queue.shift();
    this._dispatching.set(role, evt);
    try {
      await this._dispatchToRole(role, evt);
    } catch (err) {
      this.emit("dispatch-error", { path: evt.path, role, error: err });
    } finally {
      this._inFlightPaths.delete(evt.path);
      this._dispatching.set(role, false);
      // Drain the same role's queue further. Different roles' loops are
      // unaffected — they're each running their own _processNextDispatch.
      this._processNextDispatch(role);
    }
  }

  /**
   * Hand a parsed task off to the runner for `role`. On `status === "completed"`,
   * the queue YAML is removed; on failure it's left in place so the next start
   * picks it up again (simple retry-on-restart semantic).
   *
   * 8.1 keeps the existing single-flight serial loop. 8.2 will split serial
   * state per-role so workers can run concurrently across roles.
   */
  async _dispatchToRole(role, evt) {
    const runner = this.runners.get(role);
    if (!runner) {
      this.emit("dispatch-error", {
        path: evt.path,
        role,
        error: new Error(`No runner for role '${role}'; cannot dispatch`),
      });
      return;
    }
    if (typeof runner.execute !== "function") {
      // Stub runner from tests: just record dispatch attempt and bail.
      this.emit("dispatched", { path: evt.path, role, result: null });
      return;
    }

    const workItem = adaptTaskToWorkItem(evt.task, evt.path);
    const runtimeContext = {
      slug: this.slug,
      cwd: this.projectRoot,
      pattern: { name: "company" },
      provider: { name: "anthropic" },
    };

    const parentTaskId = evt.task?.parent_task_id ?? null;
    const recipients = this._recipientsFor(role);

    this.emit("dispatch-started", { path: evt.path, role, workItem });
    await this.eventLog.append({
      type: "dispatch-started",
      slug: this.slug,
      role,
      task_path: evt.path,
      task_title: workItem.title,
      parent_task_id: parentTaskId,
    });

    let result;
    try {
      result = await runner.execute(workItem, runtimeContext);
    } catch (err) {
      await this.eventLog.append({
        type: "dispatch-error",
        slug: this.slug,
        role,
        task_path: evt.path,
        parent_task_id: parentTaskId,
        recipients,
        error: err?.message ?? String(err),
      });
      throw err;
    }

    this.emit("dispatched", { path: evt.path, role, result });
    await this.eventLog.append({
      type: result?.status === "completed" ? "dispatch-completed" : "dispatch-failed",
      slug: this.slug,
      role,
      task_path: evt.path,
      task_title: workItem.title,
      parent_task_id: parentTaskId,
      recipients,
      status: result?.status ?? "unknown",
      outputs: Array.isArray(result?.outputs) ? result.outputs : [],
      // Include summary/transcript from runner so failures are visible in the UI.
      summary: result?.summary ?? null,
      transcript: result?.transcript ?? null,
    });

    if (result?.status === "completed") {
      try {
        await unlink(evt.path);
      } catch (err) {
        // Already deleted by another consumer or never existed — non-fatal.
        if (err?.code !== "ENOENT") {
          this.emit("dispatch-error", { path: evt.path, role, error: err });
        }
      }
    }
  }

  /**
   * Compute the recipients list for a completion/failure/error event from
   * `role`. CEO is always included unless the reporter IS the CEO. Then the
   * reporter's `delivers_to` peers are appended (deduped, self skipped).
   *
   * Pure function over the loaded company spec — no side effects.
   *
   * @param {string} reporterRole
   * @returns {string[]}
   */
  _recipientsFor(reporterRole) {
    const reporter = this.company?.agents.get(reporterRole);
    if (!reporter) return [];
    const list = [];
    if (reporterRole !== this.ceoRole) list.push(this.ceoRole);
    for (const peer of reporter.delivers_to ?? []) {
      if (peer === reporterRole) continue;
      if (list.includes(peer)) continue;
      list.push(peer);
    }
    return list;
  }

  async stop() {
    if (this.supervisor) this.supervisor.stop();
    for (const poller of this.pollers.values()) {
      await poller.stop();
    }
    this.pollers.clear();
    for (const runner of this.runners.values()) {
      if (typeof runner.stopPersistent === "function") {
        await runner.stopPersistent();
      }
    }
    this.runners.clear();
    // Close the SQLite handle so temp dirs / fs.rm in tests don't see EBUSY,
    // and so a subsequent start() reopens cleanly with a fresh prepared
    // statement cache.
    this.eventIndex.close();
    // Drop pending dispatches; in-flight executions race their own runner
    // teardown. Callers should `await stop()` after `await runtime.start()`
    // returns idle, but if a dispatch is mid-execute() the runner's own
    // commandRunner timeout governs cleanup.
    this._dispatchQueues.clear();
    this._dispatching.clear();
    this._inFlightPaths.clear();
    this.startedAt = null;
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
   * Authorize a capability call AND, if the gate flags it as needing
   * approval, block until ApprovalService produces a decision.
   *
   * Resolution shape:
   *   { allowed: true, approval?: {decision, by, at, requestId, ...} }
   *   { allowed: false, reason: string, approval?: {...} }
   *
   * Decision-to-allowed mapping:
   *   "approved"  → allowed: true
   *   "denied"    → allowed: false  (caller surfaces denial to the worker)
   *   "escalated" → allowed: false  (caller / company-ops can re-issue
   *                                   targeting `approval.escalateTo`)
   *
   * Intended caller is the company-ops MCP server (one tool call per
   * capability). For now the runtime exposes it directly so a thin HTTP
   * shim or the future MCP layer can call into it.
   */
  async authorizeWithApproval({ role, capability, taskAutonomy, requestPayload }) {
    const gate = this.authorize({ role, capability, taskAutonomy });
    if (!gate.allowed) return gate;
    if (!gate.requiresApproval) return gate;

    const agent = this.company?.agents.get(role);
    const approval = await this.approvalService.requestApproval({
      slug: this.slug,
      agent,
      capability,
      requestPayload,
    });

    if (approval.decision === "approved") {
      return { allowed: true, approval };
    }
    return {
      allowed: false,
      reason: `approval ${approval.decision} (${approval.by})`,
      approval,
    };
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
   * Snapshot for status endpoints. Returns "running" only when at least one
   * poller is live; once stop() runs it flips to "stopped". `queueDepth` is
   * the sum across all role queues.
   */
  getStatus() {
    const running = this.pollers.size > 0;
    let queueDepth = 0;
    for (const poller of this.pollers.values()) {
      queueDepth += poller.getPendingCount();
    }
    return {
      status: running ? "running" : "stopped",
      startedAt: this.startedAt,
      agents: this.listAgents().map((a) => {
        const dispatchVal = this._dispatching.get(a.role);
        const activeEvt = dispatchVal && typeof dispatchVal === "object" ? dispatchVal : null;
        const queued = this._dispatchQueues.get(a.role) ?? [];
        return {
          role: a.role,
          capabilities: a.capabilities,
          resources: a.resources ?? null,
          reports_to: a.reports_to ?? null,
          delivers_to: Array.isArray(a.delivers_to) ? a.delivers_to : [],
          activeTask: activeEvt
            ? { path: activeEvt.path, title: activeEvt.task?.title ?? null }
            : null,
          queuedTasks: queued.map((e) => ({
            path: e.path,
            title: e.task?.title ?? null,
          })),
        };
      }),
      queueDepth,
    };
  }

  /**
   * Resolve the on-disk queue directory for a given role. Used by the
   * dispatch endpoint (8.3) to write a sub-task YAML where the per-role
   * poller will pick it up.
   * @returns {string|null} absolute path, or null for unknown role
   */
  getRoleQueueDir(role) {
    return this.queueDirs[role] ?? null;
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

function defaultRunnerFactory(_unused) {
  // Default factory returns a stub runner that satisfies the
  // `runner.execute(workItem, runtimeContext)` contract. Real deployments
  // inject `dockerRunnerFactory(...)` (HermesDockerRunner) at construction;
  // the host-side one-shot hermes path is no longer supported.
  return () => new HermesAgentRunner();
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
