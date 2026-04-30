/**
 * Spec-driven agent image builder (Nix-only).
 *
 * Builds a layered Docker OCI image via `pkgs.dockerTools.buildLayeredImage`.
 * The hermes-agent binary and every nixpkgs attribute declared in the agent
 * spec's `nix_packages` field come from the pinned flake.lock — fully
 * reproducible, no OS-detection, no Dockerfiles.
 *
 * Fails fast when `nix` is not on PATH.
 *
 * Caching: in-process Set + `docker image inspect`. Nix itself is also
 * idempotent — a second build of an already-realised derivation is instant.
 *
 * Image tag: <SPECOPS_AGENT_IMAGE_PREFIX>:<12-char sha256 of sorted package list>
 */

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../utils/process.js";

const _built = new Set();
const IMAGE_PREFIX = process.env.SPECOPS_AGENT_IMAGE_PREFIX ?? "specops-agent";

function currentNixSystem() {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return `${arch}-linux`;
}

function buildNixExpr({ nixPackages, tag, nixSystem, projectRoot }) {
  const contents = nixPackages.length > 0
    ? `with pkgs; [ hermes ${nixPackages.join(" ")} ]`
    : "[ hermes ]";

  return `
let
  flake  = builtins.getFlake "path:${projectRoot}";
  pkgs   = flake.inputs.nixpkgs.legacyPackages.${nixSystem};
  hermes = flake.inputs.hermes-agent.packages.${nixSystem}.default;
in
pkgs.dockerTools.buildLayeredImage {
  name     = "${IMAGE_PREFIX}";
  tag      = "${tag}";
  contents = ${contents};
  config.Env = [
    "PYTHONUNBUFFERED=1"
    "PYTHONDONTWRITEBYTECODE=1"
  ];
}`.trim();
}

/**
 * Build (or reuse) a Nix-based Docker image for the given package set.
 *
 * @param {object}   opts
 * @param {string[]} opts.nix_packages    nixpkgs attribute names declared in the agent spec
 * @param {string}   opts.projectRoot     absolute path to haex-corp root (contains flake.nix)
 * @param {string}   [opts.dockerCommand]
 * @returns {Promise<string>}             image tag to pass to `docker run`
 */
export async function buildAgentImage({
  nix_packages = [],
  projectRoot = process.cwd(),
  dockerCommand = "docker",
}) {
  const nix = await runCommand("nix", ["--version"]);
  if (!nix.ok) {
    throw new Error(
      "buildAgentImage: `nix` not found on PATH. " +
      "Install Nix (https://nixos.org/download) or run the SpecOps server inside a Nix environment."
    );
  }

  const sorted = [...nix_packages].sort();
  const hash = crypto
    .createHash("sha256")
    .update(sorted.join("\n"))
    .digest("hex")
    .slice(0, 12);
  const tag = `${IMAGE_PREFIX}:${hash}`;

  if (_built.has(hash)) return tag;

  const inspect = await runCommand(dockerCommand, ["image", "inspect", tag, "--format", "{{.Id}}"]);
  if (inspect.ok) {
    _built.add(hash);
    return tag;
  }

  const nixSystem = currentNixSystem();
  const expr = buildNixExpr({ nixPackages: sorted, tag, nixSystem, projectRoot });
  const outLink = path.join(os.tmpdir(), `specops-nix-${hash}`);

  console.log(`[agent-image-builder] nix build '${tag}' (${sorted.join(", ") || "hermes only"})`);

  const build = await runCommand("nix", ["build", "--impure", "--expr", expr, "--out-link", outLink]);
  if (!build.ok) {
    throw new Error(`nix build failed for '${tag}':\n${build.stderr}`);
  }

  const load = await runCommand(dockerCommand, ["load", "--input", outLink]);
  if (!load.ok) {
    throw new Error(`docker load failed for '${tag}':\n${load.stderr}`);
  }

  _built.add(hash);
  console.log(`[agent-image-builder] ready: '${tag}'`);
  return tag;
}
