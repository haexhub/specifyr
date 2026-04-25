import test from "node:test";
import assert from "node:assert/strict";
import { checkCapability, SENSITIVE_CAPABILITIES } from "../src/core/capability-gate.js";

const agent = (caps) => ({ role: "test", capabilities: caps });

test("exact capability match is allowed", () => {
  const r = checkCapability({
    agent: agent(["filesystem:read"]),
    request: "filesystem:read",
  });
  assert.equal(r.allowed, true);
  assert.equal(r.requiresApproval, false);
});

test("missing capability is denied", () => {
  const r = checkCapability({
    agent: agent(["filesystem:read"]),
    request: "filesystem:write",
  });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /not granted/);
});

test("class-level wildcard ':any' allows any subclass in that class", () => {
  const r = checkCapability({
    agent: agent(["network:any"]),
    request: "network:http_post",
  });
  assert.equal(r.allowed, true);
});

test("':any' from one class does NOT grant other classes", () => {
  const r = checkCapability({
    agent: agent(["network:any"]),
    request: "shell:execute",
  });
  assert.equal(r.allowed, false);
});

test("default-deny: empty capability list denies everything", () => {
  const r = checkCapability({
    agent: agent([]),
    request: "filesystem:read",
  });
  assert.equal(r.allowed, false);
});

test("sensitive capability: payment:execute_unrestricted always requires approval", () => {
  const r = checkCapability({
    agent: agent(["payment:execute_unrestricted"]),
    request: "payment:execute_unrestricted",
    taskAutonomy: "full",
  });
  assert.equal(r.allowed, true);
  assert.equal(r.requiresApproval, true);
  assert.match(r.reason, /sensitive/i);
});

test("sensitive capability: account:* always requires approval", () => {
  const r = checkCapability({
    agent: agent(["account:youtube"]),
    request: "account:youtube",
    taskAutonomy: "full",
  });
  assert.equal(r.allowed, true);
  assert.equal(r.requiresApproval, true);
});

test("non-sensitive capability with autonomy=full does NOT require approval", () => {
  const r = checkCapability({
    agent: agent(["filesystem:write"]),
    request: "filesystem:write",
    taskAutonomy: "full",
  });
  assert.equal(r.allowed, true);
  assert.equal(r.requiresApproval, false);
});

test("supervised autonomy adds approval requirement at gates only, not for ordinary tool calls", () => {
  // Tool-call level capability check — autonomy is checked at task gates, not here
  const r = checkCapability({
    agent: agent(["filesystem:write"]),
    request: "filesystem:write",
    taskAutonomy: "supervised",
  });
  assert.equal(r.allowed, true);
  assert.equal(r.requiresApproval, false);
});

test("SENSITIVE_CAPABILITIES set includes the documented entries", () => {
  assert.ok(SENSITIVE_CAPABILITIES.has("payment:execute_unrestricted"));
  assert.ok(SENSITIVE_CAPABILITIES.has("secrets:read_vault"));
  assert.ok(SENSITIVE_CAPABILITIES.has("network:any"));
});

test("granted 'network:any' triggers approval (it's sensitive even at the grant level)", () => {
  const r = checkCapability({
    agent: agent(["network:any"]),
    request: "network:http_get",
    taskAutonomy: "full",
  });
  assert.equal(r.allowed, true);
  // network:any is sensitive — every use of it under that grant requires approval
  assert.equal(r.requiresApproval, true);
});
