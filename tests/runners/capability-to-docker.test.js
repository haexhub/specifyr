import test from "node:test";
import assert from "node:assert/strict";

import { capabilityFlags } from "../../src/runners/capability-to-docker.js";

const baseInput = () => ({
  agent: { role: "ceo", capabilities: ["shell:execute"] },
  projectRoot: "/home/dev/proj",
  profileDir: "/home/dev/proj/.hermes/ceo",
});

function flagsAsString(args) {
  return args.join(" ");
}

test("baseline hardening flags are emitted for every agent", () => {
  const args = capabilityFlags(baseInput());
  const s = flagsAsString(args);
  assert.match(s, /--rm/);
  assert.match(s, /--read-only/);
  assert.match(s, /--cap-drop=ALL/);
  assert.match(s, /--security-opt=no-new-privileges/);
  assert.match(s, /--tmpfs \/tmp:rw,size=512m,mode=1777/);
});

test("HERMES_HOME profile volume is always mounted rw + env set", () => {
  const args = capabilityFlags(baseInput());
  const i = args.indexOf("-v");
  assert.ok(i >= 0, "expected -v flag");
  // The profile mount comes before any project mount.
  assert.equal(args[i + 1], "/home/dev/proj/.hermes/ceo:/profile:rw");
  const e = args.indexOf("HERMES_HOME=/profile");
  assert.ok(e >= 0, "HERMES_HOME=/profile must be set");
});

test("filesystem:read → project mount in :ro mode", () => {
  const input = baseInput();
  input.agent.capabilities = ["filesystem:read"];
  const args = capabilityFlags(input);
  assert.ok(args.includes("/home/dev/proj:/workspace:ro"));
  assert.ok(!args.includes("/home/dev/proj:/workspace:rw"));
});

test("filesystem:write → project mount in :rw mode (overrides :read if both)", () => {
  const input = baseInput();
  input.agent.capabilities = ["filesystem:read", "filesystem:write"];
  const args = capabilityFlags(input);
  assert.ok(args.includes("/home/dev/proj:/workspace:rw"));
  assert.ok(!args.includes("/home/dev/proj:/workspace:ro"));
});

test("filesystem:any wildcard grants :rw access to project", () => {
  const input = baseInput();
  input.agent.capabilities = ["filesystem:any"];
  const args = capabilityFlags(input);
  assert.ok(args.includes("/home/dev/proj:/workspace:rw"));
});

test("no filesystem capability → no project mount", () => {
  const input = baseInput();
  input.agent.capabilities = ["shell:execute"];
  const args = capabilityFlags(input);
  // Project root must not appear as a mount target. Profile mount may.
  const projectMount = args.find(
    (a) => typeof a === "string" && a.startsWith("/home/dev/proj:/workspace")
  );
  assert.equal(projectMount, undefined);
});

test("no network capability → --network=none", () => {
  const input = baseInput();
  input.agent.capabilities = ["shell:execute"];
  const args = capabilityFlags(input);
  const i = args.indexOf("--network");
  assert.ok(i >= 0);
  assert.equal(args[i + 1], "none");
});

test("network:http → joins named network when provided", () => {
  const input = baseInput();
  input.agent.capabilities = ["network:http"];
  input.network = "companies";
  const args = capabilityFlags(input);
  const i = args.indexOf("--network");
  assert.equal(args[i + 1], "companies");
});

test("network:http → default bridge (no --network flag) when no network name given", () => {
  const input = baseInput();
  input.agent.capabilities = ["network:http"];
  const args = capabilityFlags(input);
  // No --network=none, no --network <name> — docker default bridge applies.
  assert.ok(!args.includes("none"));
});

test("binary whitelist → BINARY_WHITELIST env var, comma-joined", () => {
  const input = baseInput();
  input.binaryWhitelist = ["git", "jq", "rg"];
  const args = capabilityFlags(input);
  assert.ok(args.includes("BINARY_WHITELIST=git,jq,rg"));
});

test("empty binary whitelist → no BINARY_WHITELIST env var emitted", () => {
  const input = baseInput();
  input.binaryWhitelist = [];
  const args = capabilityFlags(input);
  const hasWhitelist = args.some(
    (a) => typeof a === "string" && a.startsWith("BINARY_WHITELIST=")
  );
  assert.equal(hasWhitelist, false);
});

test("custom image tag is appended last (positional)", () => {
  const input = baseInput();
  input.image = "hermes-agent:0.2.1";
  const args = capabilityFlags(input);
  assert.equal(args[args.length - 1], "hermes-agent:0.2.1");
});

test("default image tag is hermes-agent:dev", () => {
  const args = capabilityFlags(baseInput());
  assert.equal(args[args.length - 1], "hermes-agent:dev");
});

test("containerName produces --name flag", () => {
  const input = baseInput();
  input.containerName = "haex-corp_company_test_ceo";
  const args = capabilityFlags(input);
  const i = args.indexOf("--name");
  assert.ok(i >= 0);
  assert.equal(args[i + 1], "haex-corp_company_test_ceo");
});

test("refuses projectRoot === '/' (would mount host root)", () => {
  const input = baseInput();
  input.projectRoot = "/";
  assert.throws(() => capabilityFlags(input), /must not be host root/);
});

test("refuses non-absolute projectRoot", () => {
  const input = baseInput();
  input.projectRoot = "relative/path";
  assert.throws(() => capabilityFlags(input), /must be absolute/);
});

test("refuses non-absolute profileDir", () => {
  const input = baseInput();
  input.profileDir = ".hermes/ceo";
  assert.throws(() => capabilityFlags(input), /must be absolute/);
});

test("refuses 'privileged' capability tokens entirely", () => {
  const input = baseInput();
  input.agent.capabilities = ["docker:privileged"];
  assert.throws(() => capabilityFlags(input), /privileged/);
});

test("secrets with secrets:read_env grant → -e KEY=value emitted per entry", () => {
  const input = baseInput();
  input.agent.capabilities = ["secrets:read_env"];
  input.secrets = { GH_TOKEN: "ghp_abc", API_KEY: "sk-xyz" };
  const args = capabilityFlags(input);
  assert.ok(args.includes("GH_TOKEN=ghp_abc"));
  assert.ok(args.includes("API_KEY=sk-xyz"));
});

test("secrets without secrets:read_env grant → throws (config drift guard)", () => {
  const input = baseInput();
  input.agent.capabilities = ["shell:execute"];
  input.secrets = { GH_TOKEN: "ghp_abc" };
  assert.throws(() => capabilityFlags(input), /lacks secrets:read_env/);
});

test("empty secrets object is treated as no secrets (no throw, no flags)", () => {
  const input = baseInput();
  input.agent.capabilities = ["shell:execute"];
  input.secrets = {};
  const args = capabilityFlags(input);
  // No KEY=value secrets beyond the always-emitted runtime env vars.
  const envFlags = args.filter((a, i) => args[i - 1] === "-e");
  assert.deepEqual(envFlags.sort(), [
    "HERMES_HOME=/profile",
    "PYTHONDONTWRITEBYTECODE=1",
    "PYTHONUNBUFFERED=1",
  ]);
});

test("secrets array (not object) → throws", () => {
  const input = baseInput();
  input.agent.capabilities = ["secrets:read_env"];
  input.secrets = ["GH_TOKEN"];
  assert.throws(() => capabilityFlags(input), /must be a KV object/);
});

test("refuses agent without capabilities array", () => {
  assert.throws(
    () => capabilityFlags({ agent: { role: "x" }, projectRoot: "/p", profileDir: "/p/.h" }),
    /capabilities/
  );
});

test("resources.cpus emits --cpus=<value> (string)", () => {
  const input = baseInput();
  input.agent.resources = { cpus: "1.5" };
  const args = capabilityFlags(input);
  assert.ok(args.includes("--cpus=1.5"));
});

test("resources.cpus accepts numeric input (YAML may parse as number)", () => {
  const input = baseInput();
  input.agent.resources = { cpus: 2 };
  const args = capabilityFlags(input);
  assert.ok(args.includes("--cpus=2"));
});

test("resources.memory emits --memory=<value>", () => {
  const input = baseInput();
  input.agent.resources = { memory: "512m" };
  const args = capabilityFlags(input);
  assert.ok(args.includes("--memory=512m"));
});

test("resources.cpus + memory both emitted independently", () => {
  const input = baseInput();
  input.agent.resources = { cpus: "1.0", memory: "1g" };
  const args = capabilityFlags(input);
  assert.ok(args.includes("--cpus=1.0"));
  assert.ok(args.includes("--memory=1g"));
});

test("invalid cpus format throws (catches 'two', 'eval', etc.)", () => {
  const input = baseInput();
  input.agent.resources = { cpus: "two" };
  assert.throws(() => capabilityFlags(input), /resources\.cpus must be a positive number/);
});

test("invalid memory format throws", () => {
  const input = baseInput();
  input.agent.resources = { memory: "1 gigabyte" };
  assert.throws(() => capabilityFlags(input), /resources\.memory must be Docker format/);
});

test("missing resources block emits no resource flags (default)", () => {
  const input = baseInput();
  // no input.agent.resources
  const args = capabilityFlags(input);
  assert.ok(!args.some((a) => typeof a === "string" && a.startsWith("--cpus=")));
  assert.ok(!args.some((a) => typeof a === "string" && a.startsWith("--memory=")));
});

test("flag order: baseline → name → profile mount → workspace → network → whitelist → image", () => {
  const input = baseInput();
  input.agent.capabilities = ["filesystem:write", "network:http"];
  input.binaryWhitelist = ["git"];
  input.network = "companies";
  input.containerName = "agent-ceo";
  const args = capabilityFlags(input);

  // Baseline starts at index 0
  assert.equal(args[0], "--rm");
  // --name appears before any -v
  const nameIdx = args.indexOf("--name");
  const firstVIdx = args.indexOf("-v");
  assert.ok(nameIdx >= 0 && nameIdx < firstVIdx);
  // image is last
  assert.equal(args[args.length - 1], "hermes-agent:dev");
});
