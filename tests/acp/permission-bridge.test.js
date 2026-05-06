import test from "node:test";
import assert from "node:assert/strict";
import { acpPermissionToCapability, capabilityDecisionToAcpOutcome } from "../../src/acp/permission-bridge.js";

test("maps Edit/Write to filesystem:write", () => {
  assert.equal(acpPermissionToCapability({ title: "Edit" }), "filesystem:write");
  assert.equal(acpPermissionToCapability({ title: "Write" }), "filesystem:write");
});

test("maps Bash to shell:execute", () => {
  assert.equal(acpPermissionToCapability({ title: "Bash" }), "shell:execute");
});

test("maps Read to filesystem:read", () => {
  assert.equal(acpPermissionToCapability({ title: "Read" }), "filesystem:read");
});

test("maps unknown title to tool:<lower>", () => {
  assert.equal(acpPermissionToCapability({ title: "Mystery" }), "tool:mystery");
  assert.equal(acpPermissionToCapability({}), "tool:unknown");
});

test("approve decision becomes allow_once", () => {
  const o = capabilityDecisionToAcpOutcome("approved", [
    { optionId: "allow_once" }, { optionId: "reject_once" }
  ]);
  assert.equal(o.outcome, "selected");
  assert.equal(o.optionId, "allow_once");
});

test("deny decision becomes reject_once", () => {
  const o = capabilityDecisionToAcpOutcome("denied", [
    { optionId: "allow_once" }, { optionId: "reject_once" }
  ]);
  assert.equal(o.optionId, "reject_once");
});

test("falls back to first option if preferred kind missing", () => {
  const o = capabilityDecisionToAcpOutcome("approved", [
    { optionId: "custom_only" }
  ]);
  assert.equal(o.optionId, "custom_only");
});
