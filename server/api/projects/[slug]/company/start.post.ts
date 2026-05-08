/**
 * POST /api/projects/<slug>/company/start
 *
 * Boots the speckit-company runtime for this project. Looks up the project
 * directory by slug, then instantiates CompanyRuntime with the docker runner
 * factory so each agent runs in its own hermes-agent container.
 *
 * Returns SSE events while building agent images and starting the runtime.
 * Events: status, building_image, image_ready, started, error, done.
 *
 * Lifecycle: one CompanyRuntime per slug for the process lifetime. Calling
 * start twice on the same slug returns 409. Stop endpoint not yet
 * implemented — restart requires `docker compose restart specifyr`.
 *
 * Path layout convention (matches existing endpoints):
 *   <projectCwd>/.specify/org/                  org dir (constitution + agents)
 *   <projectCwd>/.specifyr/<slug>/queue-<role>/  per-role task queues
 *   <repo-root>/catalog/                        global catalog (shared)
 */

import fs from "node:fs/promises";
import { dataDir } from "@su/data-dirs";
import {
  projectCwd,
  projectHostCwd,
  assertProjectExists,
} from "@su/specifyr-stores";
import {
  getCompanyRuntimeModule,
  getDockerRunnerFactoryModule,
  getAgentImageBuilderModule,
  getActiveCompany,
  registerCompany,
  isCompanyStarting,
  markCompanyStarting,
  clearCompanyStarting,
} from "@su/company-manager";
import { getProjectSecrets } from "@su/secrets-store";
import {
  resolveCredentialForRequest,
  type ResolvedCredential,
} from "@su/llm-credentials-store";
import { getProjectFromDb } from "@su/project-store";
import { mintRunnerSession } from "@su/runner-sessions-store";
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

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  const config = useRuntimeConfig(event);
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }

  await assertProjectExists(slug);

  if (getActiveCompany(slug) || isCompanyStarting(slug)) {
    throw createError({
      statusCode: 409,
      statusMessage: `Company runtime already running for project '${slug}'`,
    });
  }

  const stream = createEventStream(event);
  const push = async (name: string, payload: unknown) => {
    try { await stream.push({ event: name, data: JSON.stringify(payload) }); } catch { /* closed */ }
  };

  markCompanyStarting(slug);
  (async () => {
    try {
      const pCwd = projectCwd(slug);
      const orgDir = path.join(pCwd, ".specify", "org");
      const specifyrBase = path.join(dataDir(), ".specifyr", slug);
      const catalogDir = path.join(process.cwd(), "catalog");
      const pHostCwd = projectHostCwd(slug);

      const { CompanyRuntime } = await getCompanyRuntimeModule();
      const { dockerRunnerFactory } = await getDockerRunnerFactoryModule();
      const { buildAgentImage } = await getAgentImageBuilderModule();

      const agentSpecLoaderUrl = pathToFileURL(path.join(process.cwd(), "src/agents/spec-loader.js")).href;
      const agentSpecMod = (await import(agentSpecLoaderUrl)) as {
        loadAgents: (dir: string) => Promise<Map<string, { role: string; nix_packages?: string[] }>>;
      };

      await push("status", { message: "Loading agent specs…" });
      let agentMap: Map<string, { role: string; nix_packages?: string[] }>;
      try {
        agentMap = await agentSpecMod.loadAgents(orgDir);
      } catch (err) {
        await push("error", { message: err instanceof Error ? err.message : "Failed to load agent specs" });
        return;
      }

      const roles = [...agentMap.keys()];
      await push("roles_loaded", { roles });

      // Purge stale auth.json for every agent. hermes caches the resolved
      // credential (including the token value and auth_type) in auth.json.
      // Without deletion, a prior run's cached OAuth token overrides the
      // ANTHROPIC_API_KEY injected via -e flags — even if the key changed.
      for (const role of roles) {
        const authJsonPath = path.join(pHostCwd, ".hermes", role, "auth.json");
        try { await fs.unlink(authJsonPath); } catch { /* not present */ }
      }

      const queueDirs: Record<string, string> = {};
      for (const role of roles) {
        queueDirs[role] = path.join(specifyrBase, `queue-${role}`);
      }

      const agentImages = new Map<string, string>();
      for (const [role, agent] of agentMap) {
        const nix_packages = agent.nix_packages ?? [];
        await push("building_image", { role, packages: nix_packages });

        // Firefox closes idle fetch SSE streams aggressively — send an immediate
        // heartbeat then repeat every 2s to keep the connection alive during builds.
        await push("heartbeat", { role });
        const heartbeat = setInterval(() => { push("heartbeat", { role }); }, 2_000);
        try {
          const image = await buildAgentImage({
            nix_packages,
            // Docker bind mounts are resolved by the HOST daemon; use the host-side
            // equivalent of process.cwd() when specifyr runs in a container.
            projectRoot: process.env.SPECIFYR_HOST_PROJECT_ROOT || process.cwd(),
            onLog: (line: string) => { push("build_log", { role, line }); },
          });
          agentImages.set(role, image);
          await push("image_ready", { role, tag: image });
        } catch (err) {
          await push("error", { message: err instanceof Error ? err.message : `Image build failed for '${role}'` });
          return;
        } finally {
          clearInterval(heartbeat);
        }
      }

      await push("status", { message: "Starting company runtime…" });

      const opsToken = randomBytes(32).toString("hex");
      const opsUrl = config.companyOpsUrlBase;
      const projectSecrets = await getProjectSecrets(slug);

      // Resolve the LLM credential ONCE up front so the per-agent
      // secretsResolver below stays sync-friendly (the resolver is
      // hot-called by the runner factory and must not do per-agent DB
      // queries). userId comes from the auth middleware — null in
      // single-user/legacy mode, in which case we fall back to the
      // existing runtimeConfig + project-secret chain.
      //
      // Resolution priority (Phase 5):
      //   1. user-personal credential
      //   2. project-owner-org credential (if project is org-owned)
      //
      // Phase 6: when the resolved row is `mode='oauth_claude'`, we
      // mint a short-lived runner_session token and inject IT as the
      // ANTHROPIC_API_KEY. The haex-claude-proxy (Phase 7) resolves
      // that token back to (ownerKind, ownerId) and spawns the claude
      // CLI with the matching credentials directory. The agent itself
      // never sees the OAuth token, only the throwaway session token.
      const userId = event.context.userId;
      let resolvedAnthropic: ResolvedCredential | null = null;
      let oauthSessionToken: string | null = null;
      if (userId) {
        const project = await getProjectFromDb(slug);
        if (!project || !project.ownerOrgId) {
          throw createError({
            statusCode: 409,
            statusMessage: "Project ownership metadata missing",
          });
        }
        const ownerOrgId = project.ownerOrgId;
        resolvedAnthropic = await resolveCredentialForRequest(
          userId,
          ownerOrgId,
          "anthropic",
        );
        if (resolvedAnthropic?.mode === "oauth_claude") {
          const minted = await mintRunnerSession({
            userId,
            owner: {
              kind: resolvedAnthropic.ownerKind,
              id: resolvedAnthropic.ownerId,
            },
          });
          oauthSessionToken = minted.token;
        }
      }

      const runnerFactory = dockerRunnerFactory({
        projectRoot: pHostCwd,
        imageForRole: (role) => {
          const img = agentImages.get(role);
          if (!img) throw new Error(`No image built for agent role '${role}'`);
          return img;
        },
        network: "companies",
        secretsResolver: (agent: any) => {
          if (!agent?.capabilities?.includes?.("secrets:read_env")) return undefined;
          const env: Record<string, string> = {
            COMPANY_OPS_TOKEN: opsToken,
            COMPANY_OPS_URL: `${opsUrl}/${slug}`,
          };

          // Resolution priority for the Anthropic credential:
          //   1a. user-personal api_key (Phase 4) — most specific.
          //   1b. user-personal oauth_claude — minted session token
          //       routed through the multi-tenant proxy.
          //   2.  project-owner-org credential (Phase 5) — same modes,
          //       fallback for members who didn't add a personal one.
          //   3.  deployment-wide runtimeConfig + project secrets.
          //
          // The legacy "shared OAuth via host ~/.claude" path is
          // intentionally absent: the proxy is multi-tenant only, and
          // a request without a per-user OAuth credential goes
          // straight to the direct Anthropic API path (api_key from
          // runtimeConfig).
          const proxyUrl = config.companyClaudeProxyUrl || undefined;
          if (resolvedAnthropic?.mode === "api_key") {
            env.ANTHROPIC_API_KEY = resolvedAnthropic.apiKey;
            if (resolvedAnthropic.baseUrl)
              env.ANTHROPIC_BASE_URL = resolvedAnthropic.baseUrl;
          } else if (resolvedAnthropic?.mode === "oauth_claude" && oauthSessionToken && proxyUrl) {
            // Token IS the API key from the agent's perspective; the
            // proxy unpacks it server-side. baseUrl on the credential
            // overrides the deployment proxy when set (per-tenant
            // proxy fan-out, not currently used but cheap to support).
            env.ANTHROPIC_BASE_URL = resolvedAnthropic.baseUrl || proxyUrl;
            env.ANTHROPIC_API_KEY = oauthSessionToken;
          } else {
            // Direct API: runtimeConfig takes priority, then project secrets.
            const apiKey = config.anthropicApiKey || projectSecrets["ANTHROPIC_API_KEY"];
            if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
            if (config.anthropicBaseUrl) env.ANTHROPIC_BASE_URL = config.anthropicBaseUrl;
          }

          // Pass through any other non-ANTHROPIC project secrets.
          for (const [k, v] of Object.entries(projectSecrets)) {
            if (v && !k.startsWith("ANTHROPIC_")) env[k] = v;
          }
          return env;
        },
      });

      const transport = await buildApprovalTransport();
      let approvalService: unknown = undefined;
      if (transport) {
        const url = pathToFileURL(path.join(process.cwd(), "src/core/capability-approval-service.js")).href;
        const mod = (await import(url)) as ApprovalServiceModule;
        approvalService = new mod.CapabilityApprovalService({ transport });
      }

      const runtime = new CompanyRuntime({
        projectRoot: pCwd, hostProjectRoot: pHostCwd, orgDir, queueDirs, catalogDir, slug, opsToken, runnerFactory, approvalService,
      });

      try {
        await runtime.start();
      } catch (err) {
        await push("error", { message: err instanceof Error ? err.message : "Company runtime failed to start" });
        return;
      }

      registerCompany(slug, runtime);
      const agents = runtime.listAgents();

      const sentinelPath = path.join(pCwd, ".specify", "org", "company-started.md");
      const agentList = agents.map((a: any) => `- ${a.role}`).join("\n");
      await fs.writeFile(
        sentinelPath,
        `---\nstatus: started\ntimestamp: ${new Date().toISOString()}\nagents: ${agents.length}\n---\n\n✓ Company '${slug}' is live.\n\n## Agents\n\n${agentList}\n`,
        "utf8"
      );

      await push("started", {
        slug,
        agents: agents.map((a: any) => ({
          role: a.role,
          capabilities: a.capabilities,
          resources: a.resources ?? null,
        })),
      });
    } catch (err) {
      await push("error", { message: err instanceof Error ? err.message : "Unexpected error" });
    } finally {
      clearCompanyStarting(slug);
      await push("done", {});
      try { await stream.close(); } catch { /* already closed */ }
    }
  })();

  stream.onClosed(() => { /* client disconnected — IIFE continues, push calls are no-ops */ });

  return stream.send();
});
