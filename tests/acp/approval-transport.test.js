import test from "node:test";
import assert from "node:assert/strict";
import { AcpApprovalTransport } from "../../src/acp/approval-transport.js";
import { CapabilityApprovalService } from "../../src/core/capability-approval-service.js";

test("transport routes notify() to session/request_permission and resolves approved", async () => {
  const calls = [];
  const fakeClient = {
    requestPermission: async (req) => {
      calls.push(req);
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
    }
  };
  const transport = new AcpApprovalTransport({ client: fakeClient });
  transport.bindSession({ slug: "x", stepId: "s", sid: "y" }, "specifyr:1:x:s:y");

  const decision = await transport.notify({
    slug: "x",
    requestId: "r1",
    capability: "filesystem:write",
    requestPayload: { toolCall: { title: "Edit", toolCallId: "tc-1" } }
  });
  assert.equal(decision, "approved");
  assert.equal(calls[0].sessionId, "specifyr:1:x:s:y");
  assert.equal(calls[0].toolCall.toolCallId, "tc-1");
});

test("transport returns undefined when no session bound", async () => {
  const transport = new AcpApprovalTransport({
    client: { requestPermission: async () => { throw new Error("must not be called"); } }
  });
  const decision = await transport.notify({
    slug: "x", requestId: "r2", capability: "filesystem:write", requestPayload: {}
  });
  assert.equal(decision, undefined);
});

test("transport returns 'denied' when client selects reject", async () => {
  const fakeClient = {
    requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "reject_once" } })
  };
  const transport = new AcpApprovalTransport({ client: fakeClient });
  transport.bindSession({ slug: "x" }, "specifyr:1:x:s:y");
  const decision = await transport.notify({
    slug: "x", requestId: "r", capability: "shell:execute", requestPayload: { toolCall: { title: "Bash", toolCallId: "tc-2" } }
  });
  assert.equal(decision, "denied");
});

test("transport synthesises a toolCall when requestPayload lacks one", async () => {
  let observed = null;
  const fakeClient = {
    requestPermission: async (req) => { observed = req; return { outcome: { outcome: "selected", optionId: "reject_once" } }; }
  };
  const transport = new AcpApprovalTransport({ client: fakeClient });
  transport.bindSession({ slug: "x" }, "specifyr:1:x:s:y");
  await transport.notify({ slug: "x", requestId: "r", capability: "secrets:read_vault", requestPayload: {} });
  assert.ok(observed.toolCall);
  assert.equal(observed.toolCall.title, "secrets:read_vault");
  assert.ok(observed.toolCall.toolCallId.startsWith("cap-"));
});

test("unbind removes the binding", async () => {
  const transport = new AcpApprovalTransport({
    client: { requestPermission: async () => { throw new Error("must not be called"); } }
  });
  transport.bindSession({ slug: "x" }, "specifyr:1:x:s:y");
  transport.unbind("x");
  const decision = await transport.notify({ slug: "x", requestId: "r", capability: "x", requestPayload: {} });
  assert.equal(decision, undefined);
});

test("CAS resolves via AcpApprovalTransport when one is registered and bound", async () => {
  const service = new CapabilityApprovalService({});
  const fakeClient = {
    requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow_once" } })
  };
  const transport = new AcpApprovalTransport({ client: fakeClient });
  transport.bindSession({ slug: "x", stepId: "s", sid: "sid" }, "specifyr:1:x:s:sid");
  service.addTransport(transport);

  const result = await service.requestApproval({
    slug: "x",
    agent: { role: "worker", approval: { timeout: "5s", on_timeout: "deny" } },
    capability: "filesystem:write",
    requestPayload: { toolCall: { title: "Edit", toolCallId: "tc-1" } }
  });

  assert.equal(result.decision, "approved");
  assert.equal(result.by, "acp");
});

test("CAS denies via AcpApprovalTransport when client rejects", async () => {
  const service = new CapabilityApprovalService({});
  const transport = new AcpApprovalTransport({
    client: { requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "reject_once" } }) }
  });
  transport.bindSession({ slug: "x" }, "specifyr:1:x:s:sid");
  service.addTransport(transport);

  const result = await service.requestApproval({
    slug: "x",
    agent: { role: "worker", approval: { timeout: "5s", on_timeout: "deny" } },
    capability: "shell:execute",
    requestPayload: { toolCall: { title: "Bash", toolCallId: "tc-2" } }
  });

  assert.equal(result.decision, "denied");
});

test("CAS falls through to timeout when no transport is bound for slug", async () => {
  const service = new CapabilityApprovalService({ defaultTimeoutMs: 50 });
  const transport = new AcpApprovalTransport({
    client: { requestPermission: async () => { throw new Error("must not be called"); } }
  });
  // No bindSession.
  service.addTransport(transport);

  const result = await service.requestApproval({
    slug: "y",
    agent: { role: "worker", approval: { timeout: "50ms", on_timeout: "deny" } },
    capability: "filesystem:write",
    requestPayload: {}
  });

  assert.equal(result.decision, "denied");
  assert.equal(result.by, "timeout");
});
