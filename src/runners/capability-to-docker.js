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
 *   secrets KV arg          →  -e KEY=value for each entry. The caller
 *                              resolves which secrets reach a given agent
 *                              (per-agent `secrets:` allowlist in the spec);
 *                              this module does NOT gate on a capability —
 *                              what reaches it is what gets injected.
 *   tools.binaries: [...]   →  -e BINARY_WHITELIST=<csv> (consumed by the
 *                              hermes-agent entrypoint; the image holds
 *                              every catalog binary in quarantine)
 *   agent.resources.cpus    →  --cpus=<value>           override default 1.5
 *   agent.resources.memory  →  --memory=<value>         override default 2g
 *   agent.resources.pidsLimit →  --pids-limit=<int>     override default 512
 *   agent.resources.ulimitNofile →  --ulimit nofile=…   override default 1024:2048
 *   (any of the above set to `null` opts out of the flag entirely; useful
 *    only for tightly trusted local-dev scenarios — DO NOT do this in SaaS)
 *
 * Baseline hardening applied to every container regardless of capabilities:
 *   --rm                    remove container on exit
 *   --read-only             rootfs is read-only; writes go to mounted
 *                           volumes only
 *   --cap-drop=ALL          drop every Linux capability (the kernel kind,
 *                           unrelated to our agent capabilities)
 *   --security-opt=no-new-privileges
 *   --tmpfs /tmp:rw,size=512m,mode=1777
 *                           agents need writable scratch but we cap it
 *   resource defaults       see DEFAULT_RESOURCE_LIMITS below — prevents
 *                           a runaway agent from starving the host
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

const BASELINE_FLAGS_PERSISTENT = Object.freeze(
  BASELINE_FLAGS.filter((f) => f !== "--rm")
);

/**
 * Default resource limits applied to every agent container. SaaS-ready
 * floor: prevents a single runaway agent from starving the host. Each
 * field is independently overridable via `agent.resources` in the agent
 * spec. Set conservatively — most code agents finish well under these
 * caps. Bump per-agent if a legitimate workload (large model context,
 * massive repos) needs more.
 *
 * Why default + overridable rather than admin-set-cap-only:
 *   - operators can tune the host-wide floor via env if needed,
 *   - agent authors can declare elevated needs explicitly in the spec,
 *   - a tenant cannot raise their own cap above what the operator
 *     configures (see SAAS_ROADMAP §2 → admin-cap follow-up).
 */
const DEFAULT_RESOURCE_LIMITS = Object.freeze({
  cpus: "1.5",
  memory: "2g",
  pidsLimit: 512,
  // ulimit nofile=soft:hard. 1024 matches typical Linux user defaults;
  // hard-capped to prevent fd-exhaustion DoS against the host.
  ulimitNofile: "1024:2048",
});

/**
 * @param {object} input
 * @param {{role: string, capabilities: string[], tools?: {binaries?: string[]}}} input.agent
 * @param {string} input.projectRoot   absolute host path of the spec-kit project
 * @param {string} input.profileDir    absolute host path for HERMES_HOME bind mount
 * @param {string[]} [input.binaryWhitelist]  resolved binary IDs (post wildcard expansion)
 * @param {Object<string,string>} [input.secrets]
 *                                     KV map of env vars to inject. Caller
 *                                     resolves the values (e.g. from
 *                                     process.env or a vault) using the
 *                                     agent's per-spec `secrets:` allowlist.
 * @param {string} [input.image]       container image tag (default: hermes-agent:dev)
 * @param {string} [input.network]     compose network name agents join (e.g. "companies")
 * @param {string} [input.containerName]  optional --name value
 * @param {string} [input.composeProject] When set, emits Docker Compose labels
 *                                     (com.docker.compose.project / .service /
 *                                     .oneoff) so all agents spawned for one
 *                                     specifyr project appear as a single
 *                                     stack in Docker Desktop and `docker
 *                                     compose ls`. The value should be the
 *                                     project slug (already sanitised by the
 *                                     caller). Compose treats labelled
 *                                     containers as part of the project even
 *                                     without a compose.yaml on disk.
 * @param {string} [input.composeService] Service name within the stack (the
 *                                     agent role). Only used when
 *                                     composeProject is set.
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
 * @param {boolean} [input.remove]     Include `--rm` in baseline flags.
 *                                     Set to false for persistent containers
 *                                     that must survive beyond a single
 *                                     command (managed via docker stop/rm).
 *                                     Defaults to true.
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
  composeProject,
  composeService,
  userId,
  remove = true,
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

  const flags = [...(remove ? BASELINE_FLAGS : BASELINE_FLAGS_PERSISTENT)];

  if (containerName) flags.push("--name", containerName);
  if (userId) flags.push("--user", String(userId));

  // Compose labels: when composeProject is set, every container we spawn for
  // a specifyr project carries the standard `com.docker.compose.*` labels.
  // Docker Desktop and `docker compose ls` group containers by these labels,
  // so the agents for one project show up as one stack — no compose.yaml on
  // disk required. The sanitised slug becomes the project name; the role
  // becomes the service name. Setting `oneoff=False` keeps Compose treating
  // them as long-lived service replicas (matters for the persistent runner
  // and for `docker compose down -p <slug>` semantics).
  if (composeProject) {
    flags.push("--label", `com.docker.compose.project=${composeProject}`);
    if (composeService) {
      flags.push("--label", `com.docker.compose.service=${composeService}`);
    }
    flags.push("--label", "com.docker.compose.oneoff=False");
  }

  // Resource limits. DEFAULT_RESOURCE_LIMITS provides a SaaS-safe floor;
  // agent.resources overrides per-field. Format-validated here so config
  // drift surfaces at start-time, not when docker fails the run.
  const userResources = (agent.resources && typeof agent.resources === "object")
    ? agent.resources
    : {};
  const resources = { ...DEFAULT_RESOURCE_LIMITS, ...userResources };

  const cpus = String(resources.cpus);
  if (!/^\d+(\.\d+)?$/.test(cpus)) {
    throw new Error(
      `capabilityFlags: agent '${agent.role}' resources.cpus must be a positive number, got '${cpus}'`
    );
  }
  flags.push(`--cpus=${cpus}`);

  const memory = String(resources.memory);
  if (!/^\d+[bkmgBKMG]?$/.test(memory)) {
    throw new Error(
      `capabilityFlags: agent '${agent.role}' resources.memory must be Docker format (e.g. '512m', '2g'), got '${memory}'`
    );
  }
  flags.push(`--memory=${memory}`);

  const pidsLimit = resources.pidsLimit;
  if (pidsLimit !== null) {
    if (!Number.isInteger(pidsLimit) || pidsLimit <= 0) {
      throw new Error(
        `capabilityFlags: agent '${agent.role}' resources.pidsLimit must be a positive integer, got '${pidsLimit}'`
      );
    }
    flags.push(`--pids-limit=${pidsLimit}`);
  }

  const ulimitNofile = resources.ulimitNofile;
  if (ulimitNofile !== null) {
    const nofile = String(ulimitNofile);
    // Accept either "soft:hard" or a single int (docker accepts both).
    if (!/^\d+(:\d+)?$/.test(nofile)) {
      throw new Error(
        `capabilityFlags: agent '${agent.role}' resources.ulimitNofile must be 'N' or 'soft:hard', got '${nofile}'`
      );
    }
    flags.push("--ulimit", `nofile=${nofile}`);
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

  // Network: default-deny. Any `network:*` capability grants outbound access
  // (`network:http`, `network:fetch`, `network:any`, etc. all map to Docker
  // network access — the capability name describes the agent's semantic
  // intent; the Docker layer enforces at the network level, not the protocol).
  const hasNetwork = [...caps].some((c) => c.startsWith("network:"));
  if (hasNetwork) {
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

  // Secrets → -e KEY=value. Per-agent allowlisting is the caller's job
  // (start.post.ts filters by `agent.secrets`); this module just emits
  // flags for whatever the caller decided to pass.
  if (secrets !== undefined && secrets !== null) {
    if (typeof secrets !== "object" || Array.isArray(secrets)) {
      throw new Error("capabilityFlags: secrets must be a KV object {KEY: value}");
    }
    for (const [key, value] of Object.entries(secrets)) {
      flags.push("-e", `${key}=${value}`);
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
