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
import { projectArtifactsDir } from "@su/data-dirs";
import {
  projectCwd,
  projectHostCwd,
  assertProjectExists,
} from "@su/specifyr-stores";
import {
  getCompanyRuntimeModule,
  getDockerRunnerFactoryModule,
  getAgentImageBuilderModule,
  getCompanyNetworkModule,
  defaultCompanyNetworkPeers,
  getActiveCompany,
  registerCompany,
  isCompanyStarting,
  markCompanyStarting,
  clearCompanyStarting,
} from "@su/company-manager";
import { getOrgSecrets, getProjectSecrets } from "@su/secrets-store";
import {
  resolveAgentProfileForRequest,
  type ResolvedAgentProfile,
} from "@su/llm-agent-profiles-store";
import { getOrgInitStatus } from "@su/org-store";
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
  const orgId = event.context.orgId!;
  const orgSlug = event.context.orgSlug!;
  const slug = event.context.projectSlug!;
  const config = useRuntimeConfig(event);

  await assertProjectExists(orgId, slug);

  if (getActiveCompany(orgId, slug) || isCompanyStarting(orgId, slug)) {
    throw createError({
      statusCode: 409,
      statusMessage: `Company runtime already running for project '${slug}'`,
    });
  }

  // Agent-vault Phase 1 guard: refuse to spawn agents for an org whose
  // vault provisioning hasn't completed. Phase 1 only writes the org
  // row in 'pending_vault_init'; Phase 3 (vault daemon) will flip it
  // to 'ready' once the per-org DEK exists. Returning null here means
  // "no DB / no project row" — let downstream code surface that
  // failure with its own 404. We only block on a known-pending status.
  const initStatus = await getOrgInitStatus(orgId);
  if (initStatus === "pending_vault_init") {
    throw createError({
      statusCode: 503,
      statusMessage:
        "Org vault not yet initialised — agent runtime unavailable",
    });
  }

  const stream = createEventStream(event);
  const push = async (name: string, payload: unknown) => {
    try { await stream.push({ event: name, data: JSON.stringify(payload) }); } catch { /* closed */ }
  };

  markCompanyStarting(orgId, slug);
  let networkOwnedButUnregistered = false;
  let networkPeersForCleanup: string[] = [];
  // Per-org docker network identity. Slugs are unique per org (not globally),
  // so keying the network by slug alone would let orgA/foo collide with
  // orgB/foo and the failed-start cleanup could tear down the other org's
  // network. orgId is a UUID — safe inside docker network names.
  const dockerCompanyId = `${orgId}-${slug}`;
  (async () => {
    try {
      const pCwd = projectCwd(orgId, slug);
      const orgDir = path.join(pCwd, ".specify", "org");
      const specifyrBase = projectArtifactsDir(orgId, slug);
      const catalogDir = path.join(process.cwd(), "catalog");
      const pHostCwd = projectHostCwd(orgId, slug);

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

      // Validate every role has its own LLM profile BEFORE we burn time
      // building images. Profiles are owner-scoped (user-personal wins
      // over project-owner-org); a missing profile is a hard error
      // surfaced to the UI's runtime page → Agent LLMs.
      const userId = event.context.userId;
      if (!userId) {
        await push("error", {
          message: "Starting a company requires an authenticated user.",
        });
        return;
      }

      const ownerOrgId: string = orgId;

      const profilesByRole = new Map<string, ResolvedAgentProfile>();
      const agentSessionTokens = new Map<string, string>();
      const missingProfileRoles: string[] = [];
      for (const role of roles) {
        const profile = await resolveAgentProfileForRequest(
          userId,
          ownerOrgId,
          "company-agent",
          role,
        );
        if (!profile) {
          missingProfileRoles.push(role);
          continue;
        }
        profilesByRole.set(role, profile);
        // Mint a credential-bound runner session for every credential the
        // proxy can route. Anthropic is the only api_key provider proxied
        // today; the others still inject their raw key into the agent env
        // until the proxy grows endpoints for them.
        const proxied =
          profile.credential.mode === "oauth_claude" ||
          (profile.credential.mode === "api_key" &&
            profile.provider === "anthropic");
        if (proxied) {
          const minted = await mintRunnerSession({
            userId,
            owner: {
              kind: profile.credential.ownerKind,
              id: profile.credential.ownerId,
            },
            credentialId: profile.credential.id,
          });
          agentSessionTokens.set(role, minted.token);
        }
      }

      if (missingProfileRoles.length > 0) {
        await push("error", {
          message:
            `No LLM profile configured for: ${missingProfileRoles.join(", ")}. ` +
            `Open the project's runtime page → Agent LLMs and pick a provider, model, ` +
            `and credential for each role before starting the company.`,
          missingRoles: missingProfileRoles,
        });
        return;
      }

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

      // Per-company docker network. Each company gets its own bridge so
      // agents from different companies cannot reach each other on IP
      // (THREAT_MODEL V6, SAAS_ROADMAP §2). The orchestrator container
      // and the claude-proxy are attached so agents can reach MCP and
      // the proxy at their usual hostnames. If specifyr is running on
      // the host (`pnpm dev`, no container), HOSTNAME won't resolve to a
      // container and the attach is a no-op warning — agents on the
      // bridge still get isolation, just no MCP reachability via that
      // bridge (matching the existing host-dev limitation).
      const { ensureCompanyNetwork } = await getCompanyNetworkModule();
      const networkPeers = defaultCompanyNetworkPeers();
      networkPeersForCleanup = networkPeers;
      let companyNetworkName: string;
      try {
        const net = await ensureCompanyNetwork({
          companyId: dockerCompanyId,
          peers: networkPeers,
          onLog: (msg) => push("status", { message: msg }),
        });
        companyNetworkName = net.name;
        networkOwnedButUnregistered = true;
      } catch (err) {
        await push("error", {
          message: err instanceof Error
            ? `Failed to set up per-company docker network: ${err.message}`
            : "Failed to set up per-company docker network",
        });
        return;
      }

      const opsToken = randomBytes(32).toString("hex");
      const opsUrl = config.companyOpsUrlBase;
      // Org-level secrets first, project-level second — project keys
      // override org keys on collision (standard env-var precedence).
      const [orgSecrets, projectSecrets] = await Promise.all([
        getOrgSecrets(orgId),
        getProjectSecrets(orgId, slug),
      ]);
      const mergedSecrets: Record<string, string> = { ...orgSecrets, ...projectSecrets };
      const proxyUrl = config.companyClaudeProxyUrl || undefined;

      // Fail-fast: every secret an agent declares in its `secrets:` list
      // must be defined at org- or project-level. Catching this BEFORE we
      // burn time on image builds gives the operator a clear punch list
      // ("agent X needs Y, Y is missing") instead of an opaque runtime
      // env-var-undefined failure inside the container.
      const missingSecretsByRole: Record<string, string[]> = {};
      for (const [role, agent] of agentMap) {
        const declared: string[] = (agent as { secrets?: string[] }).secrets ?? [];
        const missing = declared.filter((key) => !(key in mergedSecrets));
        if (missing.length > 0) missingSecretsByRole[role] = missing;
      }
      if (Object.keys(missingSecretsByRole).length > 0) {
        const detail = Object.entries(missingSecretsByRole)
          .map(([role, keys]) => `${role}: [${keys.join(", ")}]`)
          .join("; ");
        await push("error", {
          message:
            `Missing project/org secrets — ${detail}. ` +
            `Open the project's Secrets page and define the keys, ` +
            `or remove them from the agent's 'secrets:' list.`,
          missingSecretsByRole,
        });
        return;
      }

      // Inject per-provider env for an agent that has its own profile.
      // Hermes reads the standard provider env vars (ANTHROPIC_API_KEY,
      // OPENAI_API_KEY, GOOGLE_API_KEY/GEMINI_API_KEY); OpenRouter reuses
      // the OpenAI vars with a base_url override. oauth_claude routes
      // through our multi-tenant proxy with a minted session token.
      const buildEnvForProfile = (
        profile: ResolvedAgentProfile,
        sessionToken: string | undefined,
      ): Record<string, string> => {
        const env: Record<string, string> = {};
        const cred = profile.credential;
        if (cred.mode === "api_key") {
          if (profile.provider === "anthropic") {
            // Route Anthropic api_key through the proxy too — the agent
            // container never sees the real key. Always pin to proxyUrl
            // (COMPANY_CLAUDE_PROXY_URL): cred.baseUrl is the *upstream*
            // URL the proxy hits with the decrypted key, NOT a per-agent
            // override; letting it win here would send the session token
            // straight to api.anthropic.com and 401.
            if (!proxyUrl) {
              throw new Error(
                `Agent profile for role '${profile.agentRole}' uses Anthropic api_key but COMPANY_CLAUDE_PROXY_URL is not configured.`,
              );
            }
            if (!sessionToken) {
              throw new Error(
                `Agent profile for role '${profile.agentRole}' uses Anthropic api_key but no runner session was minted.`,
              );
            }
            env.ANTHROPIC_BASE_URL = proxyUrl;
            env.ANTHROPIC_API_KEY = sessionToken;
          } else if (profile.provider === "openai") {
            env.OPENAI_API_KEY = cred.apiKey;
            if (cred.baseUrl) env.OPENAI_BASE_URL = cred.baseUrl;
          } else if (profile.provider === "openrouter") {
            env.OPENAI_API_KEY = cred.apiKey;
            env.OPENAI_BASE_URL = cred.baseUrl || "https://openrouter.ai/api/v1";
          } else if (profile.provider === "google") {
            env.GOOGLE_API_KEY = cred.apiKey;
            env.GEMINI_API_KEY = cred.apiKey;
            if (cred.baseUrl) env.GOOGLE_BASE_URL = cred.baseUrl;
          }
        } else {
          // oauth_claude — Anthropic only, routed through the proxy.
          // Same pin-to-proxyUrl rule as the api_key branch above:
          // cred.baseUrl is unused here (the claude CLI inside the proxy
          // ignores it anyway), and letting it override the proxy would
          // bypass the only path that can decrypt the OAuth blob.
          if (!proxyUrl) {
            throw new Error(
              `Agent profile for role '${profile.agentRole}' uses Claude OAuth but COMPANY_CLAUDE_PROXY_URL is not configured.`,
            );
          }
          if (!sessionToken) {
            throw new Error(
              `Agent profile for role '${profile.agentRole}' uses Claude OAuth but no runner session was minted.`,
            );
          }
          env.ANTHROPIC_BASE_URL = proxyUrl;
          env.ANTHROPIC_API_KEY = sessionToken;
        }
        return env;
      };

      const runnerFactory = dockerRunnerFactory({
        projectRoot: pHostCwd,
        imageForRole: (role) => {
          const img = agentImages.get(role);
          if (!img) throw new Error(`No image built for agent role '${role}'`);
          return img;
        },
        network: companyNetworkName,
        agentLlmResolver: (agent: any) => {
          const profile = profilesByRole.get(agent?.role);
          if (!profile) return null;
          return { provider: profile.provider, model: profile.model };
        },
        secretsResolver: (agent: any) => {
          // Every agent gets ops-token + LLM env. The LLM-profile env vars
          // (ANTHROPIC_*, OPENAI_*, …) are infrastructure managed by the
          // platform, not user secrets — they don't go through the
          // `agent.secrets:` allowlist.
          const env: Record<string, string> = {
            COMPANY_OPS_TOKEN: opsToken,
            COMPANY_OPS_URL: `${opsUrl}/${slug}`,
          };

          const profile = profilesByRole.get(agent?.role);
          if (!profile) {
            throw new Error(
              `Internal: no LLM profile resolved for agent role '${agent?.role}'. ` +
                `This indicates a bug in the upfront validation.`,
            );
          }
          Object.assign(
            env,
            buildEnvForProfile(profile, agentSessionTokens.get(agent.role)),
          );

          // Per-agent allowlist: only the keys the agent declared in its
          // `secrets:` frontmatter list get injected. Missing keys were
          // already caught by the fail-fast check above, so a non-string
          // value here means the secret was empty/blank — skip it.
          const declared: string[] = agent?.secrets ?? [];
          for (const key of declared) {
            const value = mergedSecrets[key];
            if (typeof value === "string" && value.length > 0) {
              env[key] = value;
            }
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

      registerCompany({ orgId, orgSlug, slug }, runtime);
      networkOwnedButUnregistered = false;
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
      clearCompanyStarting(orgId, slug);
      // If we created the per-company network but never reached
      // registerCompany, stop.post.ts will never clean it up. Tear it
      // down here so we don't leak docker networks on failed starts.
      if (networkOwnedButUnregistered) {
        try {
          const { removeCompanyNetwork } = await getCompanyNetworkModule();
          await removeCompanyNetwork({
            companyId: dockerCompanyId,
            peers: networkPeersForCleanup,
          });
        } catch { /* best-effort */ }
      }
      await push("done", {});
      try { await stream.close(); } catch { /* already closed */ }
    }
  })();

  stream.onClosed(() => { /* client disconnected — IIFE continues, push calls are no-ops */ });

  return stream.send();
});
