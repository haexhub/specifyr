/**
 * Pure capability → `docker run` flag mapping.
 *
 * Translates an agent's capability list (plus its catalog binary list, project
 * root, and per-agent profile dir) into the array of CLI flags that must be
 * passed to `docker run` for that agent's container to enforce the right
 * sandbox.
 *
 * This module does NOT spawn docker, does NOT read the filesystem, and has no
 * I/O side effects — it's a pure function so it can be unit-tested in
 * isolation. The Hermes-Docker runner (5.2) consumes the output verbatim.
 *
 * Mapping (synced with docs/plans/2026-04-25-inkrement-5-...):
 *   filesystem:read         →  -v <projectRoot>:/workspace:ro
 *   filesystem:write        →  -v <projectRoot>:/workspace:rw
 *   filesystem:any          →  -v <projectRoot>:/workspace:rw
 *                              (`:any` = "all current filesystem subclasses",
 *                              i.e. read + write; matches strongest grant)
 *   (no filesystem cap)     →  no project mount; only profile volume
 *   network:http            →  joins named network or default bridge
 *   (no network cap)        →  --network=none
 *   secrets:read_env        →  -e KEY=value for each entry in `secrets` arg
 *                              (the caller supplies the KV map; this module
 *                              does NOT read process.env itself, to stay pure)
 *   tools.binaries: [...]   →  -e BINARY_WHITELIST=<csv> (consumed by the
 *                              hermes-agent entrypoint; the image holds
 *                              every catalog binary in quarantine)
 *
 * Baseline hardening applied to every container regardless of capabilities:
 *   --rm                    remove container on exit
 *   --read-only             rootfs is read-only; writes go to mounted
 *                           volumes only
 *   --cap-drop=ALL          drop every Linux capability (the kernel kind,
 *                           unrelated to our agent capabilities)
 *   --security-opt=no-new-privileges
 *   --tmpfs /tmp:rw,size=64m,mode=1777
 *                           agents need writable scratch but we cap it
 *
 * Refusals: this function THROWS on inputs it considers unsafe rather than
 * silently emitting weaker flags. Callers must catch and surface to the
 * orchestrator. Refused inputs:
 *   - projectRoot === "/"   (would mount the host root)
 *   - profileDir === "/"    (same)
 *   - any capability containing "privileged" (no path to it via grants)
 *   - projectRoot or profileDir not absolute
 */

const BASELINE_FLAGS = Object.freeze([
  "--rm",
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--tmpfs",
  "/tmp:rw,size=64m,mode=1777",
]);

/**
 * @param {object} input
 * @param {{role: string, capabilities: string[], tools?: {binaries?: string[]}}} input.agent
 * @param {string} input.projectRoot   absolute host path of the spec-kit project
 * @param {string} input.profileDir    absolute host path for HERMES_HOME bind mount
 * @param {string[]} [input.binaryWhitelist]  resolved binary IDs (post wildcard expansion)
 * @param {Object<string,string>} [input.secrets]
 *                                     KV map of env vars to inject. Caller
 *                                     resolves the values (e.g. from
 *                                     process.env or a vault). Throws if
 *                                     given without a `secrets:read_env`
 *                                     grant.
 * @param {string} [input.image]       container image tag (default: hermes-agent:dev)
 * @param {string} [input.network]     compose network name agents join (e.g. "companies")
 * @param {string} [input.containerName]  optional --name value
 * @returns {string[]}                 docker run argv (after `docker run`, before image tag)
 */
export function capabilityFlags({
  agent,
  projectRoot,
  profileDir,
  binaryWhitelist,
  secrets,
  image = "hermes-agent:dev",
  network,
  containerName,
}) {
  if (!agent || !Array.isArray(agent.capabilities)) {
    throw new Error("capabilityFlags: agent.capabilities (string[]) is required");
  }
  assertSafeAbsolutePath("projectRoot", projectRoot);
  assertSafeAbsolutePath("profileDir", profileDir);

  const caps = new Set(agent.capabilities);
  if ([...caps].some((c) => /privileged/i.test(c))) {
    throw new Error(
      `capabilityFlags: agent '${agent.role}' references a 'privileged' capability — refusing to map`
    );
  }

  const flags = [...BASELINE_FLAGS];

  if (containerName) flags.push("--name", containerName);

  // Profile volume (HERMES_HOME) is ALWAYS mounted rw — Hermes needs to
  // persist memory/sessions per-agent. This is the per-agent state, not the
  // project workspace.
  flags.push("-v", `${profileDir}:/profile:rw`);
  flags.push("-e", "HERMES_HOME=/profile");

  // Filesystem: project mount mode comes from filesystem:* capability.
  if (caps.has("filesystem:write") || caps.has("filesystem:any")) {
    flags.push("-v", `${projectRoot}:/workspace:rw`);
  } else if (caps.has("filesystem:read")) {
    flags.push("-v", `${projectRoot}:/workspace:ro`);
  }
  // else: no project mount. Agent has profile-only access.

  // Network: default-deny.
  if (caps.has("network:http")) {
    if (network) {
      flags.push("--network", network);
    }
    // else: docker default bridge applies — no flag needed.
  } else {
    flags.push("--network", "none");
  }

  // Binary whitelist → entrypoint env var.
  if (Array.isArray(binaryWhitelist) && binaryWhitelist.length > 0) {
    flags.push("-e", `BINARY_WHITELIST=${binaryWhitelist.join(",")}`);
  }

  // Secrets → -e KEY=value, gated on secrets:read_env. Hard-fail if the
  // caller passes secrets without the matching capability (otherwise a
  // typo in the agent spec would silently strip credentials from the
  // container — looks like the agent works in tests but fails in prod).
  if (secrets !== undefined && secrets !== null) {
    if (typeof secrets !== "object" || Array.isArray(secrets)) {
      throw new Error("capabilityFlags: secrets must be a KV object {KEY: value}");
    }
    const entries = Object.entries(secrets);
    if (entries.length > 0) {
      if (!caps.has("secrets:read_env")) {
        throw new Error(
          `capabilityFlags: agent '${agent.role}' lacks secrets:read_env but caller passed secrets [${entries
            .map(([k]) => k)
            .join(", ")}]`
        );
      }
      for (const [key, value] of entries) {
        flags.push("-e", `${key}=${value}`);
      }
    }
  }

  // Image last (positional after flags).
  flags.push(image);
  return flags;
}

function assertSafeAbsolutePath(label, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`capabilityFlags: ${label} is required`);
  }
  if (value[0] !== "/") {
    throw new Error(`capabilityFlags: ${label} must be absolute, got '${value}'`);
  }
  if (value === "/") {
    throw new Error(`capabilityFlags: ${label} must not be host root '/'`);
  }
}
