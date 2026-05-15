/**
 * Company runtime registry & module loaders.
 *
 * One CompanyRuntime per project slug, kept in a module-scoped Map for the
 * lifetime of the Node process. Mirrors the pattern in run-manager.ts.
 *
 * Module loading is dynamic (pathToFileURL + import) because src/core/ and
 * src/runners/ are pure ESM JS modules outside Nitro's bundle — same reason
 * that run-manager.ts uses loadEsm() for the scheduler / task-graph modules.
 *
 * Known limitation (deferred): when specifyr itself runs inside a container,
 * `process.cwd()` is /app, but the Hermes-Agent containers spawned via
 * docker.sock need HOST paths in their bind mounts (the docker daemon
 * resolves bind sources host-side, not against specifyr' container fs).
 * Fix planned for the next iteration via a SPECIFYR_HOST_PROJECT_ROOT env
 * var that translates /app/projects/<slug> → <host-path>/projects/<slug>.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

interface CompanyRuntimeInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  opsToken: string;
  slug: string;
  ceoRole: string;
  listAgents(): Array<{ role: string; capabilities: string[]; resources?: unknown }>;
  getAgent(role: string): {
    role: string;
    capabilities: string[];
    resources?: unknown;
  } | null;
  getRoleQueueDir(role: string): string | null;
  getStatus(): {
    status: "running" | "stopped";
    agents: Array<{ role: string; capabilities: string[]; resources: unknown }>;
    queueDepth: number;
  };
  authorizeWithApproval(input: {
    role: string;
    capability: string;
    taskAutonomy?: string;
    requestPayload?: unknown;
  }): Promise<{
    allowed: boolean;
    reason?: string;
    requiresApproval?: boolean;
    approval?: {
      decision: "approved" | "denied" | "escalated";
      by: string;
      at: string;
      requestId?: string;
      escalateTo?: string | null;
    };
  }>;
  getResolvedTools(role: string): unknown[];
  getResolvedSkills(role: string): unknown[];
  getResolvedBinaries(role: string): unknown[];
  on(event: string, listener: (...args: unknown[]) => void): void;
  eventIndex: {
    recent(opts?: { limit?: number; since?: string; role?: string }): Array<{
      id: string;
      at: string;
      type: string;
      slug: string | null;
      role: string | null;
      task_path: string | null;
      parent_task_id: string | null;
      status: string | null;
      payload: Record<string, unknown>;
    }>;
    pendingDispatches(): Array<{
      id: string;
      at: string;
      role: string | null;
      task_path: string | null;
      parent_task_id: string | null;
      payload: Record<string, unknown>;
    }>;
  };
  approvalService: {
    listPending(): Array<{
      requestId: string;
      slug: string;
      agent: string;
      capability: string;
    }>;
    resolve(
      requestId: string,
      input: { decision: "approved" | "denied" | "escalated"; by?: string },
    ): boolean;
  };
}

interface CompanyRuntimeModule {
  CompanyRuntime: new (opts: {
    projectRoot: string;
    hostProjectRoot?: string;
    orgDir: string;
    queueDirs: Record<string, string>;
    catalogDir?: string;
    runnerFactory?: (agent: unknown, runtimeMeta?: unknown) => unknown;
    hermesBinary?: string;
    slug?: string;
    ceoRole?: string;
    opsToken?: string;
    approvalService?: unknown;
  }) => CompanyRuntimeInstance;
}

interface DockerRunnerFactoryModule {
  dockerRunnerFactory: (cfg: {
    projectRoot: string;
    imageForRole?: (role: string) => string;
    image?: string;
    network?: string;
    secretsResolver?: (agent: unknown) => Record<string, string> | undefined;
    agentLlmResolver?: (
      agent: unknown,
    ) => { provider: string; model: string } | null | undefined;
  }) => (agent: unknown, runtimeMeta?: unknown) => unknown;
}

interface AgentImageBuilderModule {
  buildAgentImage: (opts: {
    nix_packages: string[];
    projectRoot?: string;
    dockerCommand?: string;
    onLog?: (line: string) => void;
  }) => Promise<string>;
}

interface CompanyNetworkModule {
  companyNetworkName: (companyId: string) => string;
  ensureCompanyNetwork: (input: {
    companyId: string;
    peers?: (string | undefined | null)[];
    onLog?: (message: string) => void;
    dockerCommand?: string;
  }) => Promise<{ name: string; created: boolean; attached: string[] }>;
  removeCompanyNetwork: (input: {
    companyId: string;
    peers?: (string | undefined | null)[];
    onLog?: (message: string) => void;
    dockerCommand?: string;
  }) => Promise<{ name: string; removed: boolean }>;
}

async function loadEsm<T>(rel: string): Promise<T> {
  const url = pathToFileURL(path.join(process.cwd(), rel)).href;
  return import(url) as Promise<T>;
}

export async function getCompanyRuntimeModule() {
  return loadEsm<CompanyRuntimeModule>("src/core/company-runtime.js");
}

export async function getDockerRunnerFactoryModule() {
  return loadEsm<DockerRunnerFactoryModule>("src/runners/hermes-docker.js");
}

export async function getAgentImageBuilderModule() {
  return loadEsm<AgentImageBuilderModule>("src/runners/agent-image-builder.js");
}

export async function getCompanyNetworkModule() {
  return loadEsm<CompanyNetworkModule>("src/runners/company-network.js");
}

/**
 * Names of containers that need to be reachable from inside a company's
 * agent containers (orchestrator MCP, claude proxy). When specifyr runs in
 * docker compose these resolve via the per-company bridge attached at
 * start. Override via env (comma-separated) for non-default setups; empty
 * peers are tolerated by ensureCompanyNetwork.
 */
export function defaultCompanyNetworkPeers(): string[] {
  const fromEnv = process.env.SPECIFYR_COMPANY_NETWORK_PEERS;
  if (fromEnv) {
    return fromEnv.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const peers: string[] = [];
  if (process.env.HOSTNAME) peers.push(process.env.HOSTNAME);
  peers.push(process.env.COMPANY_CLAUDE_PROXY_CONTAINER ?? "claude-proxy");
  return peers;
}

// globalThis persists across Nitro HMR reloads. A module-scoped Map would be
// re-created on each reload while old pollers kept running — causing duplicate
// company runtimes to dispatch the same task twice (one container per runtime).
interface RegisteredCompany {
  runtime: CompanyRuntimeInstance;
  orgId: string;
  orgSlug: string;
  slug: string;
}

declare global {
  var __companyRegistry: Map<string, RegisteredCompany> | undefined;
  var __companyStartingSet: Set<string> | undefined;
}

// Registry key: `${orgId}/${slug}` because project slugs are unique only
// per-org. Lookups by slug alone are intentionally NOT supported anymore —
// the caller must know which org's company they're targeting.
const registry: Map<string, RegisteredCompany> =
  globalThis.__companyRegistry ?? (globalThis.__companyRegistry = new Map());
const startingSet: Set<string> =
  globalThis.__companyStartingSet ?? (globalThis.__companyStartingSet = new Set());

function key(orgId: string, slug: string): string {
  return `${orgId}/${slug}`;
}

export function getActiveCompany(
  orgId: string,
  slug: string,
): CompanyRuntimeInstance | undefined {
  return registry.get(key(orgId, slug))?.runtime;
}

export function isCompanyStarting(orgId: string, slug: string): boolean {
  return startingSet.has(key(orgId, slug));
}

export function markCompanyStarting(orgId: string, slug: string) {
  startingSet.add(key(orgId, slug));
}

export function clearCompanyStarting(orgId: string, slug: string) {
  startingSet.delete(key(orgId, slug));
}

export function registerCompany(
  ctx: { orgId: string; orgSlug: string; slug: string },
  runtime: CompanyRuntimeInstance,
) {
  const k = key(ctx.orgId, ctx.slug);
  const existing = registry.get(k);
  if (existing && existing.runtime !== runtime) {
    existing.runtime.stop().catch(() => {});
  }
  registry.set(k, { runtime, orgId: ctx.orgId, orgSlug: ctx.orgSlug, slug: ctx.slug });
}

/**
 * Iterate every active runtime. Used by approval endpoints that need to
 * find a request without knowing its owning company up-front.
 */
export function listActiveCompanies(): RegisteredCompany[] {
  return [...registry.values()];
}

/**
 * Find the runtime that owns a given approval request-id, by scanning each
 * runtime's pending list. Returns null if no active runtime has it.
 */
export function findRuntimeByApprovalId(
  requestId: string,
): RegisteredCompany | null {
  for (const entry of registry.values()) {
    const pending = entry.runtime.approvalService.listPending();
    if (pending.some((p) => p.requestId === requestId)) {
      return entry;
    }
  }
  return null;
}

/**
 * Slug-only lookup for the MCP worker → server callback. Workers only know
 * their slug + bearer token, not the orgId. Because slugs are unique per
 * org (not globally), two orgs can have an active runtime for the same
 * slug — we must disambiguate by token, not just take the first match.
 * Token comparison here uses constant-time matching via the supplied
 * `tokensMatch`, so a probe of `slug` alone leaks nothing about which
 * orgs are running it.
 */
export function findCompanyBySlugForMcp(
  slug: string,
  opsToken: string,
  tokensMatch: (provided: string, expected: string) => boolean,
): RegisteredCompany | undefined {
  for (const entry of registry.values()) {
    if (entry.slug !== slug) continue;
    if (tokensMatch(opsToken, entry.runtime.opsToken)) return entry;
  }
  return undefined;
}

export function deregisterCompany(orgId: string, slug: string) {
  registry.delete(key(orgId, slug));
}
