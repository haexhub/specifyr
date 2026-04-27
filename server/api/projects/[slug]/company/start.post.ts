/**
 * POST /api/projects/<slug>/company/start
 *
 * Boots the speckit-company runtime for this project. Looks up the project
 * directory by slug, then instantiates CompanyRuntime with the docker runner
 * factory so each agent runs in its own hermes-agent container.
 *
 * Returns once `runtime.start()` has finished provisioning agent profile
 * dirs and starting the queue poller — does NOT wait for any agent to
 * dispatch a task. The caller (UI) gets the agent roster back and can
 * monitor activity via subsequent endpoints (deferred).
 *
 * Lifecycle: one CompanyRuntime per slug for the process lifetime. Calling
 * start twice on the same slug returns 409. Stop endpoint not yet
 * implemented — restart requires `docker compose restart haex-corp`.
 *
 * Path layout convention (matches existing endpoints):
 *   <projectCwd>/.specify/org/                  org dir (constitution + agents)
 *   <projectCwd>/.specops/<slug>/queue-<role>/  per-role task queues
 *   <repo-root>/catalog/                        global catalog (shared)
 */

import {
  projectCwd,
  projectHostCwd,
  assertProjectExists,
} from "../../../../utils/specops-stores";
import {
  getCompanyRuntimeModule,
  getDockerRunnerFactoryModule,
  getActiveCompany,
  registerCompany,
} from "../../../../utils/company-manager";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

interface NotifyTransport {
  notify(input: { channel: string; payload: object }): Promise<void>;
}
interface ApprovalServiceModule {
  CapabilityApprovalService: new (opts?: { transport?: NotifyTransport }) => unknown;
}
interface TelegramTransportModule {
  TelegramTransport: new (opts: {
    botToken: string;
    chatId: string;
    approvalUrlBase?: string;
  }) => { notify(payload: object): Promise<void> };
}
interface CompositeTransportModule {
  CompositeTransport: new (
    transports: Record<string, { notify(payload: object): Promise<void> }>,
  ) => NotifyTransport;
}

/**
 * Build a CompositeTransport from env-configured channels. Returns null when
 * no channel is configured — the ApprovalService then falls back to its
 * default NoopTransport. Keeping the env-detection in one place makes adding
 * channels (signal, email, slack) a 4-line change here.
 */
async function buildApprovalTransport(): Promise<NotifyTransport | null> {
  const transports: Record<string, { notify(payload: object): Promise<void> }> = {};

  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    const url = pathToFileURL(path.join(process.cwd(), "src/transports/telegram.js")).href;
    const mod = (await import(url)) as TelegramTransportModule;
    transports.telegram = new mod.TelegramTransport({
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
      approvalUrlBase: process.env.APPROVAL_URL_BASE,
    });
  }

  if (Object.keys(transports).length === 0) return null;

  const url = pathToFileURL(path.join(process.cwd(), "src/transports/composite.js")).href;
  const mod = (await import(url)) as CompositeTransportModule;
  return new mod.CompositeTransport(transports);
}

// Pre-load the company spec so we know which agent roles exist. The
// runtime needs an explicit `queueDirs: { [role]: dir }` map at
// construction time, and the only source of truth for "which roles" is
// the org spec on disk. Re-loading inside runtime.start() is idempotent
// (pure fs reads), so the duplicate cost is negligible.
async function loadAgentRoles(orgDir: string): Promise<string[]> {
  const url = pathToFileURL(path.join(process.cwd(), "src/agents/spec-loader.js")).href;
  const mod = (await import(url)) as {
    loadAgents: (
      dir: string,
      opts?: { includeRetired?: boolean }
    ) => Promise<Map<string, { role: string }>>;
  };
  const agents = await mod.loadAgents(orgDir);
  return [...agents.keys()];
}

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }

  await assertProjectExists(slug);

  if (getActiveCompany(slug)) {
    throw createError({
      statusCode: 409,
      statusMessage: `Company runtime already running for project '${slug}'`,
    });
  }

  // Container-side paths: used by Node code in haex-corp itself (mkdir,
  // readFile, watchers). When running natively on the host these equal the
  // host paths.
  const pCwd = projectCwd(slug);
  const orgDir = path.join(pCwd, ".specify", "org");
  const specopsBase = path.join(process.cwd(), ".specops", slug);
  const catalogDir = path.join(process.cwd(), "catalog");

  // Host-side path: passed to dockerRunnerFactory because the Docker daemon
  // resolves bind-mount sources against the HOST filesystem, not against
  // haex-corp's container view. See specops-stores.ts:hostProjectRoot.
  const pHostCwd = projectHostCwd(slug);

  const { CompanyRuntime } = await getCompanyRuntimeModule();
  const { dockerRunnerFactory } = await getDockerRunnerFactoryModule();

  // Build per-role queue dirs from the active agent roster. Pre-loading
  // agents here means a misconfigured org spec surfaces as a clean 400
  // before we mint a token / build a runner factory.
  let roles: string[];
  try {
    roles = await loadAgentRoles(orgDir);
  } catch (err) {
    throw createError({
      statusCode: 400,
      statusMessage: err instanceof Error ? err.message : "Failed to load agent specs",
    });
  }
  const queueDirs: Record<string, string> = {};
  for (const role of roles) {
    queueDirs[role] = path.join(specopsBase, `queue-${role}`);
  }

  // Generate the per-runtime ops token here so the same value flows into
  // both the runtime (server-side validation) AND the secretsResolver
  // closure (worker-side env injection). Constructed before the runtime
  // because the resolver needs it at runner-build time.
  const opsToken = randomBytes(32).toString("hex");
  // URL workers use to call back into the company-ops MCP server.
  // Default targets the compose service name; override via env for
  // bare-metal/native runs or alternate routing.
  const opsUrl =
    process.env.COMPANY_OPS_URL_BASE ?? "http://haex-corp:3000/mcp";

  // Default secrets forwarding: any agent with `secrets:read_env` gets
  // ANTHROPIC_API_KEY (LLM auth) plus COMPANY_OPS_TOKEN/URL (callback
  // channel). capability-to-docker.js hard-fails if secrets are passed
  // without the cap, so we only emit when the cap is granted.
  const runnerFactory = dockerRunnerFactory({
    projectRoot: pHostCwd,
    network: "companies",
    secretsResolver: (agent: any) => {
      if (!agent?.capabilities?.includes?.("secrets:read_env")) return undefined;
      const env: Record<string, string> = {
        COMPANY_OPS_TOKEN: opsToken,
        COMPANY_OPS_URL: `${opsUrl}/${slug}`,
      };
      if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      return env;
    },
    // image resolved via factory: explicit > HERMES_AGENT_IMAGE > hermes-agent:dev
  });

  // Build the notification transport (optional — falls back to no-op if no
  // channel env vars are set). The ApprovalService takes ownership; agents
  // declare which channel they want via `approval.notify_via` in their spec.
  const transport = await buildApprovalTransport();
  let approvalService: unknown = undefined;
  if (transport) {
    const url = pathToFileURL(
      path.join(process.cwd(), "src/core/capability-approval-service.js"),
    ).href;
    const mod = (await import(url)) as ApprovalServiceModule;
    approvalService = new mod.CapabilityApprovalService({ transport });
  }

  const runtime = new CompanyRuntime({
    projectRoot: pCwd,
    orgDir,
    queueDirs,
    catalogDir,
    slug,
    opsToken,
    runnerFactory,
    approvalService,
  });

  try {
    await runtime.start();
  } catch (err) {
    throw createError({
      statusCode: 400,
      statusMessage: err instanceof Error ? err.message : "Company runtime failed to start",
    });
  }

  registerCompany(slug, runtime);

  return {
    status: "started",
    slug,
    agents: runtime.listAgents().map((a) => ({
      role: a.role,
      capabilities: a.capabilities,
      resources: a.resources ?? null,
    })),
  };
});
