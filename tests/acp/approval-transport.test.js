import test from "node:test";
import assert from "node:assert/strict";
import { AcpApprovalTransport } from "../../src/acp/approval-transport.js";

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

test("transport returns 'denied' when no session bound", async () => {
  const transport = new AcpApprovalTransport({
    client: { requestPermission: async () => { throw new Error("must not be called"); } }
  });
  const decision = await transport.notify({
    slug: "x", requestId: "r2", capability: "filesystem:write", requestPayload: {}
  });
  assert.equal(decision, "denied");
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
  assert.equal(decision, "denied");
});
