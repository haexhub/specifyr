import test from "node:test";
import assert from "node:assert/strict";

import { CapabilityApprovalService, NoopTransport } from "../src/core/capability-approval-service.js";

function counterIdGen() {
  let n = 0;
  return () => `req-${++n}`;
}

function recordingTransport() {
  const calls = [];
  return {
    calls,
    async notify(input) {
      calls.push(input);
    },
  };
}

function recordingEventStore() {
  const entries = [];
  return {
    entries,
    async append(entry) {
      entries.push(entry);
    },
  };
}

const minimalAgent = (role = "ceo", approval = {}) => ({
  role,
  capabilities: [],
  approval,
});

test("requestApproval resolves when resolve() is called explicitly", async () => {
  const svc = new CapabilityApprovalService({ idGen: counterIdGen() });
  const promise = svc.requestApproval({
    slug: "demo",
    agent: minimalAgent("worker", { timeout: "10s" }),
    capability: "fs:write_outside_workspace",
  });
  // resolve before timeout fires
  const resolved = svc.resolve("req-1", { decision: "approved", by: "user" });
  assert.equal(resolved, true);
  const result = await promise;
  assert.equal(result.decision, "approved");
  assert.equal(result.by, "user");
  assert.equal(result.requestId, "req-1");
});

test("resolve() returns false for unknown requestId", () => {
  const svc = new CapabilityApprovalService({ idGen: counterIdGen() });
  assert.equal(svc.resolve("does-not-exist", { decision: "approved" }), false);
});

test("timeout fires with on_timeout=deny → decision 'denied'", async () => {
  const svc = new CapabilityApprovalService({ idGen: counterIdGen() });
  const result = await svc.requestApproval({
    slug: "demo",
    agent: minimalAgent("worker", { timeout: "10ms", on_timeout: "deny" }),
    capability: "payment:execute_unrestricted",
  });
  assert.equal(result.decision, "denied");
  assert.equal(result.by, "timeout");
});

test("timeout with on_timeout=escalate-to-ceo → decision 'escalated', default escalateTo='ceo'", async () => {
  const svc = new CapabilityApprovalService({ idGen: counterIdGen() });
  const result = await svc.requestApproval({
    slug: "demo",
    agent: minimalAgent("worker", { timeout: "10ms", on_timeout: "escalate-to-ceo" }),
    capability: "fs:write_outside_workspace",
  });
  assert.equal(result.decision, "escalated");
  assert.equal(result.escalateTo, "ceo");
});

test("escalation routes to agent.reports_to when set", async () => {
  const svc = new CapabilityApprovalService({ idGen: counterIdGen() });
  const agent = {
    role: "worker",
    capabilities: [],
    reports_to: "engineering-lead",
    approval: { timeout: "10ms", on_timeout: "escalate-to-ceo" },
  };
  const result = await svc.requestApproval({
    slug: "demo",
    agent,
    capability: "fs:write_outside_workspace",
  });
  assert.equal(result.decision, "escalated");
  assert.equal(result.escalateTo, "engineering-lead");
});

test("approval.escalate_to overrides reports_to for escalation routing", async () => {
  const svc = new CapabilityApprovalService({ idGen: counterIdGen() });
  const agent = {
    role: "worker",
    capabilities: [],
    reports_to: "product-manager",
    approval: {
      timeout: "10ms",
      on_timeout: "escalate-to-ceo",
      escalate_to: "security-officer",
    },
  };
  const result = await svc.requestApproval({
    slug: "demo",
    agent,
    capability: "secrets:read_env",
  });
  assert.equal(result.escalateTo, "security-officer");
});

test("timeout with on_timeout=retry-once → decision 'denied'", async () => {
  const svc = new CapabilityApprovalService({ idGen: counterIdGen() });
  const result = await svc.requestApproval({
    slug: "demo",
    agent: minimalAgent("worker", { timeout: "10ms", on_timeout: "retry-once" }),
    capability: "secrets:read_env",
  });
  assert.equal(result.decision, "denied");
});

test("falls back to defaultTimeoutMs when agent has no approval.timeout", async () => {
  const svc = new CapabilityApprovalService({
    idGen: counterIdGen(),
    defaultTimeoutMs: 15,
  });
  const result = await svc.requestApproval({
    slug: "demo",
    agent: minimalAgent("worker", {}),
    capability: "x:y",
  });
  assert.equal(result.decision, "denied"); // default on_timeout=deny
});

test("notify_via channels are dispatched through transport", async () => {
  const transport = recordingTransport();
  const svc = new CapabilityApprovalService({ idGen: counterIdGen(), transport });
  // resolve immediately so we don't wait for timeout
  const promise = svc.requestApproval({
    slug: "demo",
    agent: minimalAgent("worker", {
      timeout: "60s",
      notify_via: ["signal", "email"],
    }),
    capability: "fs:write_outside_workspace",
    requestPayload: { path: "/etc/foo" },
  });
  // Allow the synchronous-loop notifies to settle.
  await new Promise((r) => setImmediate(r));
  svc.resolve("req-1", { decision: "approved", by: "user" });
  await promise;

  assert.equal(transport.calls.length, 2);
  assert.deepEqual(
    transport.calls.map((c) => c.channel),
    ["signal", "email"]
  );
  assert.equal(transport.calls[0].payload.requestId, "req-1");
  assert.equal(transport.calls[0].payload.capability, "fs:write_outside_workspace");
});

test("transport errors are surfaced as 'transport-error' events, do not block", async () => {
  const failingTransport = {
    async notify() {
      throw new Error("network down");
    },
  };
  const svc = new CapabilityApprovalService({ idGen: counterIdGen(), transport: failingTransport });
  const errors = [];
  svc.on("transport-error", (e) => errors.push(e));
  const promise = svc.requestApproval({
    slug: "demo",
    agent: minimalAgent("worker", {
      timeout: "30s",
      notify_via: ["signal"],
    }),
    capability: "x:y",
  });
  await new Promise((r) => setImmediate(r));
  svc.resolve("req-1", { decision: "approved", by: "user" });
  await promise;

  assert.equal(errors.length, 1);
  assert.equal(errors[0].channel, "signal");
  assert.equal(errors[0].err.message, "network down");
});

test("eventStore receives 'approval_requested' and 'approval_decided' on resolve", async () => {
  const eventStore = recordingEventStore();
  const svc = new CapabilityApprovalService({ idGen: counterIdGen(), eventStore });
  const promise = svc.requestApproval({
    slug: "demo",
    agent: minimalAgent("worker", { timeout: "30s", on_timeout: "deny" }),
    capability: "secrets:read_env",
  });
  await new Promise((r) => setImmediate(r));
  svc.resolve("req-1", { decision: "approved", by: "user" });
  await promise;

  const types = eventStore.entries.map((e) => e.type);
  assert.deepEqual(types, ["approval_requested", "approval_decided"]);
  assert.equal(eventStore.entries[0].approvalId, "req-1");
  assert.equal(eventStore.entries[1].decision, "approved");
});

test("eventStore receives 'approval_timeout' on timeout", async () => {
  const eventStore = recordingEventStore();
  const svc = new CapabilityApprovalService({ idGen: counterIdGen(), eventStore });
  await svc.requestApproval({
    slug: "demo",
    agent: minimalAgent("worker", { timeout: "10ms", on_timeout: "deny" }),
    capability: "x:y",
  });
  // append() may resolve in the next tick
  await new Promise((r) => setImmediate(r));

  const types = eventStore.entries.map((e) => e.type);
  assert.deepEqual(types, ["approval_requested", "approval_timeout"]);
  assert.equal(eventStore.entries[1].decision, "denied");
});

test("listPending reflects in-flight requests", async () => {
  const svc = new CapabilityApprovalService({ idGen: counterIdGen() });
  const p1 = svc.requestApproval({
    slug: "demo",
    agent: minimalAgent("worker-a", { timeout: "30s" }),
    capability: "a:b",
  });
  const p2 = svc.requestApproval({
    slug: "demo",
    agent: minimalAgent("worker-b", { timeout: "30s" }),
    capability: "c:d",
  });
  assert.equal(svc.listPending().length, 2);
  svc.resolve("req-1", { decision: "denied" });
  assert.equal(svc.listPending().length, 1);
  svc.resolve("req-2", { decision: "approved" });
  assert.equal(svc.listPending().length, 0);
  await Promise.all([p1, p2]);
});

test("missing agent or capability throws synchronously (rejected promise)", async () => {
  const svc = new CapabilityApprovalService({ idGen: counterIdGen() });
  await assert.rejects(
    () => svc.requestApproval({ slug: "demo", capability: "x:y" }),
    /agent \(spec object\) is required/
  );
  await assert.rejects(
    () => svc.requestApproval({ slug: "demo", agent: minimalAgent() }),
    /capability is required/
  );
});

test("NoopTransport.notify resolves without error", async () => {
  const t = new NoopTransport();
  await t.notify({ channel: "signal", payload: {} }); // should not throw
});
