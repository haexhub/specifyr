/**
 * Docker-runner smoke test.
 *
 * Verifies the actual hermes-agent image behaves the way the unit-tested
 * runner expects:
 *   - `hermes --version` runs (image was built, hermes is installed)
 *   - BINARY_WHITELIST exposes the listed binary
 *   - Non-whitelisted binaries are NOT reachable on PATH (quarantine works)
 *
 * Skipped automatically when:
 *   - Docker daemon is not reachable
 *   - The `hermes-agent:dev` image hasn't been built locally
 *
 * Build prerequisite for running this:
 *   docker build -f Dockerfile.hermes-agent -t hermes-agent:dev .
 *
 * Not part of the default `node --test` flow that CI runs frequently —
 * intended for local verification after image changes. Run via:
 *   node --test tests/integration/docker-runner-smoke.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { runCommand } from "../../src/utils/process.js";

const IMAGE = "hermes-agent:dev";

function gate() {
  const info = spawnSync("docker", ["info"], { stdio: "ignore" });
  if (info.status !== 0) {
    return { skip: "docker daemon not reachable" };
  }
  const inspect = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
  if (inspect.status !== 0) {
    return { skip: `image '${IMAGE}' not built — run: docker build -f Dockerfile.hermes-agent -t ${IMAGE} .` };
  }
  return { skip: false };
}

const { skip } = gate();

test("smoke: hermes --version runs in the agent image", { skip }, async () => {
  const result = await runCommand("docker", [
    "run",
    "--rm",
    IMAGE,
    "hermes",
    "--version",
  ]);
  assert.equal(result.ok, true, `expected exit 0, got ${result.code}: ${result.stderr}`);
  assert.match(result.stdout, /hermes/i);
});

test("smoke: BINARY_WHITELIST=git exposes git on PATH", { skip }, async () => {
  const result = await runCommand("docker", [
    "run",
    "--rm",
    "-e",
    "BINARY_WHITELIST=git",
    IMAGE,
    "git",
    "--version",
  ]);
  assert.equal(result.ok, true, `git --version failed: ${result.stderr}`);
  assert.match(result.stdout, /^git version /);
});

test("smoke: non-whitelisted binary is NOT on PATH (quarantine works)", { skip }, async () => {
  const result = await runCommand("docker", [
    "run",
    "--rm",
    IMAGE,
    "git",
    "--version",
  ]);
  assert.equal(result.ok, false, "expected non-zero exit when git is not whitelisted");
  // Container shell or exec emits an error on missing binary; exact text varies
  // (busybox vs glibc), but exit code != 0 is the load-bearing assertion.
});

test("smoke: BINARY_WHITELIST with unknown binary fails fast", { skip }, async () => {
  const result = await runCommand("docker", [
    "run",
    "--rm",
    "-e",
    "BINARY_WHITELIST=does-not-exist",
    IMAGE,
    "true",
  ]);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /unknown binary in BINARY_WHITELIST/);
});
