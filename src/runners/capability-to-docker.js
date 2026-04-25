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
 *   agent.resources.cpus    →  --cpus=<value>  (e.g. "1.5" or 2)
 *   agent.resources.memory  →  --memory=<value> (Docker format: 100m, 1g, …)
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

// /tmp tmpfs sized at 512m — hermes (Python) writes pyc caches, intermediate
// LLM tooling state, and skills metadata there. 64m was too small and led
// to OOM-kills (exit 137) with no stderr in the E2E test.
const BASELINE_FLAGS = Object.freeze([
  "--rm",
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--tmpfs",
  "/tmp:rw,size=512m,mode=1777",
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
 * @param {string} [input.userId]      `--user UID[:GID]` value. Forces the
 *                                     container to run as that UID instead
 *                                     of root. Critical when --cap-drop=ALL
 *                                     is used: without CAP_DAC_OVERRIDE,
 *                                     UID 0 inside the container can't
 *                                     bypass bind-mount permission checks,
 *                                     so it must MATCH the host user that
 *                                     owns the bind-mount sources.
 *                                     Caller passes `${uid}:${gid}` from
 *                                     process.getuid()/getgid() in the
 *                                     common case.
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
  userId,
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
  if (userId) flags.push("--user", String(userId));

  // Resource limits from agent.resources. Both fields are optional and
  // independently emitted. Format-validated here so config drift surfaces
  // at start-time, not when docker fails the run.
  const resources = agent.resources;
  if (resources && typeof resources === "object") {
    if (resources.cpus !== undefined && resources.cpus !== null) {
      const cpus = String(resources.cpus);
      if (!/^\d+(\.\d+)?$/.test(cpus)) {
        throw new Error(
          `capabilityFlags: agent '${agent.role}' resources.cpus must be a positive number, got '${cpus}'`
        );
      }
      flags.push(`--cpus=${cpus}`);
    }
    if (resources.memory !== undefined && resources.memory !== null) {
      const memory = String(resources.memory);
      if (!/^\d+[bkmgBKMG]?$/.test(memory)) {
        throw new Error(
          `capabilityFlags: agent '${agent.role}' resources.memory must be Docker format (e.g. '512m', '2g'), got '${memory}'`
        );
      }
      flags.push(`--memory=${memory}`);
    }
  }

  // Profile volume (HERMES_HOME) is ALWAYS mounted rw — Hermes needs to
  // persist memory/sessions per-agent. This is the per-agent state, not the
  // project workspace.
  flags.push("-v", `${profileDir}:/profile:rw`);
  flags.push("-e", "HERMES_HOME=/profile");

  // Python runtime hardening:
  //   PYTHONUNBUFFERED=1         flush stdout/stderr line-by-line so we see
  //                              hermes output even if the container exits
  //                              abruptly (caught a real diagnostics gap)
  //   PYTHONDONTWRITEBYTECODE=1  no .pyc files → no /tmp writes for caches,
  //                              keeps the 512m tmpfs from filling under
  //                              long-running hermes invocations
  flags.push("-e", "PYTHONUNBUFFERED=1");
  flags.push("-e", "PYTHONDONTWRITEBYTECODE=1");

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
