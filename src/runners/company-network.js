/**
 * Per-company docker network isolation.
 *
 * Background — see docs/THREAT_MODEL.md V6 and docs/SAAS_ROADMAP.md §2.
 * In single-operator mode every agent container joined one shared
 * `companies` bridge, which means agents from different companies could
 * reach each other on IP. For multi-tenant SaaS that's unacceptable
 * (lateral movement after a single agent compromise).
 *
 * This module creates a dedicated bridge network per CompanyRuntime,
 * `co-<companyId>`, attaches the orchestrator (specifyr itself) plus
 * any required infrastructure peers (e.g. the claude-proxy), runs all
 * of that company's agent containers on it, and tears it down on stop.
 *
 * Egress allowlisting (forcing outbound HTTP through a per-company
 * filtering proxy) is intentionally NOT part of this module — see
 * SAAS_ROADMAP §2 follow-up. Today the bridge is a normal external
 * bridge, so agents can still reach the internet. That's strictly an
 * improvement over the previous shared bridge — cross-company IP
 * reachability is gone — but it is not the full solution.
 *
 * All operations are idempotent: ensureCompanyNetwork can be called on
 * an already-existing network without error, removeCompanyNetwork on a
 * missing one returns silently. Connect/disconnect tolerate "already
 * connected" / "not connected" errors the same way.
 */

import { runCommand } from "../utils/process.js";

const COMPANY_ID_SAFE = /^[a-zA-Z0-9_.-]+$/;

/**
 * Compute the docker network name for a company id. Caller passes the
 * sanitised company id (typically the project slug). Throws on input
 * that docker would reject — fail loud at start, not when `docker network
 * create` blows up halfway through start.post.ts.
 */
export function companyNetworkName(companyId) {
  const id = String(companyId ?? "").trim();
  if (id.length === 0) {
    throw new Error("companyNetworkName: companyId is required");
  }
  if (!COMPANY_ID_SAFE.test(id)) {
    throw new Error(
      `companyNetworkName: companyId '${id}' contains characters not allowed in docker network names`
    );
  }
  return `co-${id}`;
}

/**
 * @param {object} input
 * @param {string} input.companyId
 *        Stable id for this company runtime. Same value must be passed to
 *        removeCompanyNetwork later.
 * @param {string[]} [input.peers]
 *        Container names/ids to attach to the new network so agents can
 *        reach them. Caller typically passes [specifyrHostname,
 *        claudeProxyContainer]. Any peer that fails to connect (already
 *        on the network / does not exist) is logged via onLog but does
 *        not abort — start.post.ts treats infrastructure peer connection
 *        as best-effort.
 * @param {(message: string) => void} [input.onLog]
 * @param {string} [input.dockerCommand]   default "docker", DI for tests
 * @param {Function} [input.commandRunner] default runCommand,  DI for tests
 * @returns {Promise<{name: string, created: boolean, attached: string[]}>}
 */
export async function ensureCompanyNetwork({
  companyId,
  peers = [],
  onLog,
  dockerCommand = "docker",
  commandRunner = runCommand,
}) {
  const name = companyNetworkName(companyId);
  const log = onLog ?? (() => {});

  // `docker network inspect` exits non-zero when the network is missing;
  // we use the exit code as a presence probe.
  const inspect = await commandRunner(
    dockerCommand,
    ["network", "inspect", name],
    {}
  );

  let created = false;
  if (!inspect.ok) {
    const create = await commandRunner(
      dockerCommand,
      [
        "network",
        "create",
        "--driver",
        "bridge",
        "--label",
        `com.specifyr.company=${companyId}`,
        "--label",
        "com.specifyr.kind=company-network",
        name,
      ],
      {}
    );
    if (!create.ok) {
      throw new Error(
        `ensureCompanyNetwork: failed to create network '${name}': ${create.stderr || create.stdout}`
      );
    }
    created = true;
    log(`Created docker network ${name}`);
  }

  const attached = [];
  for (const peer of peers) {
    if (!peer) continue;
    const r = await commandRunner(
      dockerCommand,
      ["network", "connect", name, peer],
      {}
    );
    if (r.ok) {
      attached.push(peer);
      log(`Attached ${peer} to ${name}`);
      continue;
    }
    // Most common non-fatal: "endpoint with name X already exists in network N".
    // Treat anything matching "already exists" as success; otherwise warn but
    // continue — the company might still work if specifyr itself is reachable
    // via another path (e.g. host networking in dev).
    const msg = (r.stderr || r.stdout || "").toLowerCase();
    if (msg.includes("already exists") || msg.includes("is already connected")) {
      attached.push(peer);
      continue;
    }
    log(`Warning: could not attach ${peer} to ${name}: ${r.stderr || r.stdout}`);
  }

  return { name, created, attached };
}

/**
 * Best-effort teardown counterpart to ensureCompanyNetwork. Disconnects
 * the given peers (silently ignoring "not connected" errors) and removes
 * the network. Never throws — stop should not fail because of cleanup.
 *
 * @param {object} input
 * @param {string} input.companyId
 * @param {string[]} [input.peers]
 * @param {(message: string) => void} [input.onLog]
 * @param {string} [input.dockerCommand]
 * @param {Function} [input.commandRunner]
 * @returns {Promise<{name: string, removed: boolean}>}
 */
export async function removeCompanyNetwork({
  companyId,
  peers = [],
  onLog,
  dockerCommand = "docker",
  commandRunner = runCommand,
}) {
  const name = companyNetworkName(companyId);
  const log = onLog ?? (() => {});

  for (const peer of peers) {
    if (!peer) continue;
    await commandRunner(
      dockerCommand,
      ["network", "disconnect", "--force", name, peer],
      {}
    ).catch(() => {});
  }

  const rm = await commandRunner(
    dockerCommand,
    ["network", "rm", name],
    {}
  ).catch(() => ({ ok: false, stderr: "exception" }));

  if (rm.ok) {
    log(`Removed docker network ${name}`);
    return { name, removed: true };
  }

  // Quiet about "no such network" — that's the desired end state.
  const msg = (rm.stderr || rm.stdout || "").toLowerCase();
  if (!msg.includes("no such network") && !msg.includes("not found")) {
    log(`Warning: could not remove ${name}: ${rm.stderr || rm.stdout}`);
  }
  return { name, removed: false };
}
