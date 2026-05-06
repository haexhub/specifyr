/**
 * CapabilityApprovalService — in-flight approval gating for sensitive
 * capability calls coming from worker containers.
 *
 * NOT to be confused with the older `ApprovalService` in approval-service.js,
 * which gates run STAGES (specify/plan/tasks) for the SpecOrchestrator. This
 * one gates individual capability invocations at runtime — e.g. a worker
 * about to execute `payment:execute_unrestricted` blocks here until the user
 * approves, denies, or the per-agent timeout fires.
 *
 * Wiring (deferred to company-ops MCP server, not part of this inkrement):
 *   1. capability-gate flags requiresApproval=true
 *   2. company-ops calls service.requestApproval(...)
 *   3. service notifies via configured channels (signal/email/...) AND
 *      persists an approval_requested event
 *   4. UI / channel reply calls service.resolve(requestId, decision)
 *   5. On no reply within agent.approval.timeout: timeout policy fires
 *
 * Per-agent declarative config (in agent spec frontmatter):
 *   approval:
 *     timeout: "5m"           # how long the worker blocks
 *     on_timeout: "deny"      # deny | escalate-to-ceo | retry-once
 *     notify_via: ["signal", "email"]
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Stub transport. Real implementations live outside this inkrement
 * (Signal-CLI, gh-notifications, nodemailer, etc.).
 */
export class NoopTransport {
  async notify() {
    // intentionally empty — keeps the request flow working without a real
    // notification channel wired up. Useful for unit tests and local dev.
  }
}

export class CapabilityApprovalService extends EventEmitter {
  /**
   * @param {object} options
   * @param {{ append: (entry: object) => Promise<void> }} [options.eventStore]
   *   optional persistence; if absent, requests are in-memory only.
   * @param {{ notify: (input: object) => Promise<void> }} [options.transport]
   *   notification transport. Defaults to NoopTransport.
   * @param {() => string} [options.idGen]  for deterministic test IDs.
   * @param {number} [options.defaultTimeoutMs]  fallback when agent has no
   *   approval.timeout. Defaults to 5 minutes.
   */
  constructor(options = {}) {
    super();
    this.eventStore = options.eventStore ?? null;
    this.transport = options.transport ?? new NoopTransport();
    this.idGen = options.idGen ?? randomUUID;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    /** @type {Map<string, {resolve: Function, timer: NodeJS.Timeout, slug: string, agent: string, capability: string}>} */
    this.pending = new Map();
    /**
     * Additional transports registered post-construction. Reserved for
     * connection-scoped routing (e.g. AcpApprovalTransport). Not yet wired into
     * decision flow — added as a registration point so the ACP server can
     * attach its transport at session-bind time.
     * @type {Array<{ notify: Function, bindSession?: Function, unbind?: Function }>}
     */
    this.transports = [];
  }

  /**
   * Register an additional transport (in addition to the constructor-provided
   * one). Connection-scoped transports — e.g. AcpApprovalTransport — attach
   * here. The decision-routing wiring lives in a follow-up task.
   */
  addTransport(transport) {
    this.transports.push(transport);
  }

  /**
   * Request approval for a capability call. Returns a Promise that resolves
   * when:
   *   - resolve() is called with the matching requestId, OR
   *   - the agent's approval.timeout fires (decision derives from on_timeout)
   *
   * Resolution shape: { decision, by, at }
   *   - decision: "approved" | "denied" | "escalated"
   *   - by: "user" | "timeout" | "ceo" (free-form actor identifier)
   *   - at: ISO timestamp
   */
  async requestApproval({ slug, agent, capability, requestPayload }) {
    if (!agent || typeof agent !== "object") {
      throw new Error("requestApproval: agent (spec object) is required");
    }
    if (!capability) {
      throw new Error("requestApproval: capability is required");
    }

    const cfg = agent.approval ?? {};
    const timeoutMs = parseTimeout(cfg.timeout) ?? this.defaultTimeoutMs;
    const onTimeout = cfg.on_timeout ?? "deny";
    const channels = Array.isArray(cfg.notify_via) ? cfg.notify_via : [];

    const requestId = this.idGen();
    const requestedAt = new Date().toISOString();

    if (this.eventStore) {
      await this.eventStore.append({
        type: "approval_requested",
        slug,
        approvalId: requestId,
        agent: agent.role,
        capability,
        requestedAt,
        timeoutMs,
        onTimeout,
        channels,
      });
    }

    // Fan out to all configured channels. Errors don't block the request —
    // the timeout still fires if no channel succeeds. We surface them as
    // events so an operator can see misconfiguration without pending requests
    // crashing.
    for (const channel of channels) {
      this.transport
        .notify({ channel, payload: { requestId, slug, agent: agent.role, capability, requestPayload, requestedAt } })
        .catch((err) => this.emit("transport-error", { channel, err, requestId }));
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        const decision = decisionForTimeout(onTimeout);
        const escalateTo = decision === "escalated" ? resolveEscalationTarget(agent) : null;
        const at = new Date().toISOString();
        if (this.eventStore) {
          this.eventStore
            .append({
              type: "approval_timeout",
              slug,
              approvalId: requestId,
              agent: agent.role,
              capability,
              decision,
              escalateTo,
              onTimeout,
              at,
            })
            .catch((err) => this.emit("event-store-error", { err, requestId }));
        }
        this.emit("timeout", {
          requestId,
          slug,
          agent: agent.role,
          capability,
          decision,
          escalateTo,
          onTimeout,
        });
        resolve({ decision, escalateTo, by: "timeout", at, requestId, onTimeout });
      }, timeoutMs);

      this.pending.set(requestId, {
        resolve,
        timer,
        slug,
        agent: agent.role,
        capability,
      });

      this.emit("requested", { requestId, slug, agent: agent.role, capability, channels });
    });
  }

  /**
   * Resolve a pending approval request explicitly (UI click, channel reply).
   *
   * @param {string} requestId
   * @param {object} input
   * @param {"approved"|"denied"|"escalated"} input.decision
   * @param {string} [input.by]   actor identifier (e.g. "user", "ceo")
   * @returns {boolean}  true if the request was pending and got resolved.
   */
  resolve(requestId, { decision, by = "user" } = {}) {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    const at = new Date().toISOString();
    if (this.eventStore) {
      this.eventStore
        .append({
          type: "approval_decided",
          slug: entry.slug,
          approvalId: requestId,
          agent: entry.agent,
          capability: entry.capability,
          decision,
          by,
          at,
        })
        .catch((err) => this.emit("event-store-error", { err, requestId }));
    }
    entry.resolve({ decision, by, at, requestId });
    return true;
  }

  /**
   * Snapshot of pending requests. Useful for status endpoints and recovery
   * after a process restart (though restart loses the in-memory promises;
   * the eventStore is the durable record).
   */
  listPending() {
    return [...this.pending.entries()].map(([requestId, e]) => ({
      requestId,
      slug: e.slug,
      agent: e.agent,
      capability: e.capability,
    }));
  }
}

/**
 * Parse a timeout like "5m", "30s", "2h", or a raw number (interpreted as ms).
 * Returns null if unparseable — caller falls back to defaultTimeoutMs.
 */
function parseTimeout(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+)\s*(ms|s|m|h)?$/i);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  switch (unit) {
    case "ms": return n;
    case "s":  return n * 1000;
    case "m":  return n * 60 * 1000;
    case "h":  return n * 60 * 60 * 1000;
    default:   return null;
  }
}

/**
 * Map an on_timeout policy to a decision:
 *   - "deny"            → "denied"
 *   - "retry-once"      → "denied" (retry semantics handled by caller)
 *   - "escalate-to-ceo" → "escalated"  (caller routes to escalateTo target)
 *
 * The service is intentionally stateless re. escalation: it returns
 * decision + escalateTo, and the caller (company-ops MCP) decides whether
 * to re-issue the request with the new audience.
 */
function decisionForTimeout(onTimeout) {
  switch (onTimeout) {
    case "deny":
    case "retry-once":
      return "denied";
    case "escalate-to-ceo":
      return "escalated";
    default:
      return "denied";
  }
}

/**
 * Resolve who an escalation goes to for the given agent. Resolution order:
 *   1. agent.approval.escalate_to    explicit per-approval override
 *   2. agent.reports_to              org hierarchy (existing spec field)
 *   3. "ceo"                          default catch-all
 *
 * (1) lets approval routing diverge from the org chart when needed
 * (e.g. risky capability X always escalates to a security role even if the
 * worker reports_to a product manager). (2) keeps the common case
 * config-free.
 */
function resolveEscalationTarget(agent) {
  return agent?.approval?.escalate_to ?? agent?.reports_to ?? "ceo";
}
