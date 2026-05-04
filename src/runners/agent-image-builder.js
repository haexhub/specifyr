/**
 * Spec-driven agent image builder.
 *
 * Builds a layered Docker OCI image via `pkgs.dockerTools.buildLayeredImage`
 * running inside a `nixos/nix` container — no host Nix required.
 * The hermes-agent binary and every nixpkgs attribute declared in the agent
 * spec's `nix_packages` field come from the pinned flake.lock — fully
 * reproducible across machines.
 *
 * Caching: in-process Set + `docker image inspect`. Nix itself is also
 * idempotent — a second build of an already-realised derivation is instant.
 *
 * Image tag: <SPECIFYR_AGENT_IMAGE_PREFIX>:<12-char sha256 of sorted package list>
 */

import crypto from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { runCommand, runPipeCommand } from "../utils/process.js";

const _built = new Set();
const IMAGE_PREFIX = process.env.SPECIFYR_AGENT_IMAGE_PREFIX ?? "specifyr-agent";

// Baseline packages always present in every agent image. coreutils provides
// `sleep` (used by HermesDockerRunner.startPersistent to keep the container
// idling) plus other minimum POSIX utilities; without it the image only has
// the hermes wrapper on PATH and `docker run … sleep infinity` fails with
// "executable file not found".
const BASELINE_PACKAGES = ["coreutils"];

function currentNixSystem() {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return `${arch}-linux`;
}

function buildNixExpr({ nixPackages, tag, nixSystem, projectRoot }) {
  const allPackages = [...BASELINE_PACKAGES, ...nixPackages];
  const contents = `with pkgs; [ hermes ${allPackages.join(" ")} ]`;

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
 * @param {string}   opts.projectRoot     absolute path to specifyr root (contains flake.nix)
 * @param {string}   [opts.dockerCommand]
 * @returns {Promise<string>}             image tag to pass to `docker run`
 */
const NIX_DOCKER_IMAGE = process.env.SPECIFYR_NIX_IMAGE ?? "nixos/nix";

export async function buildAgentImage({
  nix_packages = [],
  projectRoot = process.cwd(),
  dockerCommand = "docker",
  onLog = null,
}) {
  const sorted = [...nix_packages].sort();
  // Include flake.lock in the cache key so updates to the pinned hermes version
  // (or any other flake input) invalidate the cached image.
  let flakeLock = "";
  try {
    flakeLock = await readFile(path.join(projectRoot, "flake.lock"), "utf8");
  } catch { /* tolerate missing flake.lock */ }
  // Baseline packages participate in the cache key so adding/removing them
  // invalidates older cached images. Bumping BASELINE_PACKAGES forces a rebuild.
  const hash = crypto
    .createHash("sha256")
    .update(sorted.join("\n") + "\n" + BASELINE_PACKAGES.join(",") + "\n" + flakeLock)
    .digest("hex")
    .slice(0, 12);
  const tag = `${IMAGE_PREFIX}:${hash}`;

  if (_built.has(hash)) {
    onLog?.(`image ${tag} already built this session`);
    return tag;
  }

  const inspect = await runCommand(dockerCommand, ["image", "inspect", tag, "--format", "{{.Id}}"]);
  if (inspect.ok) {
    onLog?.(`image ${tag} found in Docker cache`);
    _built.add(hash);
    return tag;
  }

  const nixSystem = currentNixSystem();
  await _buildWithDockerNix({ sorted, hash, tag, nixSystem, projectRoot, dockerCommand, onLog });

  _built.add(hash);
  console.log(`[agent-image-builder] ready: '${tag}'`);
  return tag;
}

async function _buildWithDockerNix({ sorted, hash, tag, nixSystem, projectRoot, dockerCommand, onLog }) {
  // Base64-encode the Nix expression so it can be passed as an env var — this
  // avoids mounting a workdir bind path that only exists in the specifyr
  // container (DinD-socket: sibling containers resolve bind mounts on the HOST).
  const expr = buildNixExpr({ nixPackages: sorted, tag: hash, nixSystem, projectRoot: "/project" });
  const exprB64 = Buffer.from(expr).toString("base64");

  const nixCmd = [
    "mkdir -p /tmp/nix-build && cd /tmp/nix-build",
    "printf '%s' \"$NIX_EXPR_B64\" | base64 -d > expr.nix",
    "git config --global --add safe.directory /project",
    "nix --extra-experimental-features 'nix-command flakes' build --impure --file expr.nix",
    "cat $(readlink result)",
  ].join(" && ");

  console.log(`[agent-image-builder] docker-nix build '${tag}' via ${NIX_DOCKER_IMAGE} (${sorted.join(", ") || "hermes only"})`);

  const result = await runPipeCommand(
    dockerCommand, [
      "run", "--rm", "--privileged",
      "-v", `${projectRoot}:/project:ro`,
      "-e", `NIX_EXPR_B64=${exprB64}`,
      NIX_DOCKER_IMAGE,
      "sh", "-c", nixCmd,
    ],
    dockerCommand, ["load"],
    { onLog },
  );
  if (!result.ok) throw new Error(`docker-nix build failed for '${tag}':\n${result.stderr}`);
}
