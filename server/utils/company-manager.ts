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
 * Known limitation (deferred): when speculoss itself runs inside a container,
 * `process.cwd()` is /app, but the Hermes-Agent containers spawned via
 * docker.sock need HOST paths in their bind mounts (the docker daemon
 * resolves bind sources host-side, not against speculoss' container fs).
 * Fix planned for the next iteration via a SPECULOSS_HOST_PROJECT_ROOT env
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
    image?: string;
    network?: string;
    secretsResolver?: (agent: unknown) => Record<string, string> | undefined;
  }) => (agent: unknown, runtimeMeta?: unknown) => unknown;
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

const registry = new Map<string, CompanyRuntimeInstance>();

export function getActiveCompany(slug: string): CompanyRuntimeInstance | undefined {
  return registry.get(slug);
}

export function registerCompany(slug: string, runtime: CompanyRuntimeInstance) {
  registry.set(slug, runtime);
}

/**
 * Iterate every active runtime as `[slug, runtime]` pairs. Used by approval
 * endpoints that need to find a request without knowing its owning company —
 * the deep-link in the Telegram notification is intentionally slug-free.
 */
export function listActiveCompanies(): Array<[string, CompanyRuntimeInstance]> {
  return [...registry.entries()];
}

/**
 * Find the runtime that owns a given approval request-id, by scanning each
 * runtime's pending list. Returns null if no active runtime has it (approval
 * already resolved, timed out, or never existed).
 */
export function findRuntimeByApprovalId(
  requestId: string,
): { slug: string; runtime: CompanyRuntimeInstance } | null {
  for (const [slug, runtime] of registry) {
    const pending = runtime.approvalService.listPending();
    if (pending.some((p) => p.requestId === requestId)) {
      return { slug, runtime };
    }
  }
  return null;
}

export function deregisterCompany(slug: string) {
  registry.delete(slug);
}
