import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dataDir } from "./data-dirs";
import { resolveAgentProfileForRequest } from "./llm-agent-profiles-store";
import { mintRunnerSession } from "./runner-sessions-store";

async function loadModule<T = Record<string, unknown>>(rel: string): Promise<T> {
  const url = pathToFileURL(path.join(process.cwd(), rel)).href;
  return import(url) as Promise<T>;
}

function interpolateArgs(args: string[] = [], vars: Record<string, string>): string[] {
  return args.map((arg) =>
    arg.replace(/\{(model|provider|runner)\}/g, (_, key: string) => vars[key] ?? ""),
  );
}

function envForApiKey(input: {
  provider: string;
  apiKey: string;
  baseUrl: string | null;
  model: string;
  runnerKey: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    SPECIFYR_LLM_PROVIDER: input.provider,
    SPECIFYR_LLM_MODEL: input.model,
    SPECIFYR_AGENT_RUNNER: input.runnerKey,
  };

  if (input.provider === "anthropic") {
    env.ANTHROPIC_API_KEY = input.apiKey;
    if (input.baseUrl) env.ANTHROPIC_BASE_URL = input.baseUrl;
    // claude-agent-acp's getAvailableModels (acp-agent.js) picks the session
    // model from ANTHROPIC_MODEL → settings.model → models[0]. Neither the
    // `--model` CLI arg nor `_meta.claudeCode.options.model` survives, because
    // the wrapper calls `query.setModel(currentModel.value)` right after
    // initialization. Pinning ANTHROPIC_MODEL is the only env-level lever that
    // actually wins, and `models[0]` resolves to "default" → claude-opus-4-7.
    env.ANTHROPIC_MODEL = input.model;
  } else if (input.provider === "openai") {
    env.OPENAI_API_KEY = input.apiKey;
    if (input.baseUrl) env.OPENAI_BASE_URL = input.baseUrl;
  } else if (input.provider === "openrouter") {
    // codex-acp ignores OPENAI_BASE_URL; it routes via codex's own
    // model_providers config. The base URL is materialized into a per-run
    // CODEX_HOME/config.toml below (acp:codex branch). MODEL_PROVIDER selects
    // that provider at session start (codex-acp dist/index.js:20881).
    // DEFAULT_AUTH_REQUEST satisfies codex-acp's checkAuthorization gate
    // (dist/index.js:19918) — without it, session/new returns -32000
    // "Authentication required" even when model_provider is set in config.
    env.OPENAI_API_KEY = input.apiKey;
    env.MODEL_PROVIDER = "openrouter";
    env.DEFAULT_AUTH_REQUEST = JSON.stringify({
      methodId: "api-key",
      _meta: { "api-key": { apiKey: input.apiKey } },
    });
  } else if (input.provider === "google") {
    env.GOOGLE_API_KEY = input.apiKey;
    env.GEMINI_API_KEY = input.apiKey;
    if (input.baseUrl) env.GOOGLE_BASE_URL = input.baseUrl;
  }

  return env;
}

export async function createSpeckitRunnerFactory(input: {
  userId: string | null | undefined;
  ownerOrgId: string | null;
  runtimeConfig?: {
    companyClaudeProxyUrl?: string;
  };
}) {
  if (!input.userId) {
    throw createError({
      statusCode: 401,
      statusMessage: "Speckit agent profiles require an authenticated user.",
    });
  }

  const profile = await resolveAgentProfileForRequest(
    input.userId,
    input.ownerOrgId,
    "speckit",
  );
  if (!profile) {
    throw createError({
      statusCode: 400,
      statusMessage:
        "No Speckit agent profile configured. Choose a runner, provider, model, and credential in Settings.",
    });
  }

  const appConfigMod = await loadModule<{
    loadAppConfig: (cwd?: string) => Promise<{ acp?: Record<string, { binary?: string; args?: string[] }> }>;
  }>("src/core/app-config.js");
  const { AcpRunner } = await loadModule<{
    AcpRunner: new (opts: {
      binary: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      memoryRoot?: string;
      onEvent?: (e: unknown) => void;
      newSessionMeta?: Record<string, unknown>;
      desiredModel?: string;
      permissionMode?: "auto-approve" | "auto-deny";
    }) => unknown;
  }>("src/runners/acp.js");

  const appConfig = await appConfigMod.loadAppConfig(dataDir());
  const acpName = profile.runnerKey.slice("acp:".length);
  const acpConfig = appConfig.acp?.[acpName];
  if (!acpConfig?.binary) {
    throw createError({
      statusCode: 400,
      statusMessage: `ACP runner '${profile.runnerKey}' is not configured.`,
    });
  }

  // Route through the proxy for both oauth_claude AND Anthropic api_key —
  // the ACP runner is local (not a container) so this isn't strictly
  // about env-leak, but keeping the path consistent with company agents
  // means a single proxy + audit path for every Anthropic request.
  let env: Record<string, string>;
  const cred = profile.credential;
  if (cred.mode === "api_key" && profile.provider !== "anthropic") {
    env = envForApiKey({
      provider: profile.provider,
      apiKey: cred.apiKey,
      baseUrl: cred.baseUrl,
      model: profile.model,
      runnerKey: profile.runnerKey,
    });
  } else {
    // Pin to the configured proxy URL: cred.baseUrl is the *upstream*
    // URL the proxy uses with the decrypted key, not a per-credential
    // proxy override. Letting it win would send a session token straight
    // to api.anthropic.com (401) and, for OAuth, bypass the only path
    // that can decrypt the blob.
    const proxyUrl = input.runtimeConfig?.companyClaudeProxyUrl || "";
    if (!proxyUrl) {
      throw createError({
        statusCode: 400,
        statusMessage:
          "Anthropic credentials require COMPANY_CLAUDE_PROXY_URL.",
      });
    }
    const session = await mintRunnerSession({
      userId: input.userId,
      owner: { kind: cred.ownerKind, id: cred.ownerId },
      credentialId: cred.id,
    });
    env = {
      SPECIFYR_LLM_PROVIDER: profile.provider,
      SPECIFYR_LLM_MODEL: profile.model,
      SPECIFYR_AGENT_RUNNER: profile.runnerKey,
      ANTHROPIC_BASE_URL: proxyUrl,
      ANTHROPIC_API_KEY: session.token,
      // See envForApiKey: claude-agent-acp ignores --model and
      // `_meta.claudeCode.options.model`; ANTHROPIC_MODEL is the only env
      // hook its model resolver honors.
      ANTHROPIC_MODEL: profile.model,
    };
  }

  const args = interpolateArgs(acpConfig.args ?? [], {
    model: profile.model,
    provider: profile.provider,
    runner: profile.runnerKey,
  });

  // Belt-and-braces: forward the model via _meta as well. claude-agent-acp
  // 0.33.x reads it into the SDK's initial `options.model`, but then
  // `getAvailableModels` calls `query.setModel(...)` based on
  // ANTHROPIC_MODEL → settings.model → models[0] and overwrites it — which
  // is why ANTHROPIC_MODEL is set in the env above. We keep this in case a
  // future agent version honors the meta hint without the env override.
  // claude-agent-acp 0.33.1 forwards `_meta.claudeCode.options.*` to the SDK
  // as `userProvidedOptions` (see acp-agent.js). Pinning permissionMode to
  // `bypassPermissions` makes the Claude Code SDK auto-accept Write/Edit/Bash
  // calls WITHOUT routing through ACP's client-side request_permission flow.
  // Without it, claude-sonnet-4-6 sees the default permission gate and refuses
  // to actually emit a tool_use — it just text-replies "I have no write
  // permission". Acceptable in the Speckit chat context because the agent runs
  // as the authenticated user inside the project's bind-mounted cwd; the same
  // trust scope as our local AcpRunner permissionMode="auto-approve".
  const newSessionMeta =
    profile.runnerKey === "acp:claude"
      ? {
          claudeCode: {
            options: {
              model: profile.model,
              permissionMode: "bypassPermissions",
            },
          },
        }
      : undefined;

  const needsCodexHome =
    profile.runnerKey === "acp:codex" &&
    profile.provider === "openrouter" &&
    profile.credential.mode === "api_key";
  const codexBaseUrl = needsCodexHome
    ? profile.credential.baseUrl?.trim() || "https://openrouter.ai/api/v1"
    : null;

  return ({ cwd, onEvent }: { cwd: string; onEvent?: (e: unknown) => void }) => {
    let runEnv = env;
    if (needsCodexHome && codexBaseUrl) {
      const codexHome = path.join(cwd, ".specifyr", "agent-memory", "codex-home");
      mkdirSync(codexHome, { recursive: true });
      // codex-acp does NOT parse `--model` (dist/index.js:20761) and sends
      // `model: null` in threadStart (dist/index.js:19209) — the model is
      // resolved from this config's top-level `model` key. wire_api="chat"
      // was dropped by codex (codex/discussions/7782), only "responses" is
      // accepted now. OpenRouter has supported the Responses API in Beta
      // since 2026-02; not all models route through it cleanly, but for
      // models that do this is the only viable wire.
      const toml =
        `model = ${JSON.stringify(profile.model)}\n` +
        `model_provider = "openrouter"\n\n` +
        `[model_providers.openrouter]\n` +
        `name = "OpenRouter"\n` +
        `base_url = ${JSON.stringify(codexBaseUrl)}\n` +
        `env_key = "OPENAI_API_KEY"\n` +
        `wire_api = "responses"\n`;
      writeFileSync(path.join(codexHome, "config.toml"), toml);
      runEnv = { ...env, CODEX_HOME: codexHome };
    }
    return new AcpRunner({
      binary: acpConfig.binary!,
      args,
      cwd,
      env: runEnv,
      memoryRoot: path.join(cwd, ".specifyr", "agent-memory", acpName),
      onEvent,
      newSessionMeta,
      // codex-acp ignores model in newSession/threadStart and falls back to
      // its hardcoded default; we override post-session via session/set_model
      // inside AcpRunner.
      desiredModel: profile.runnerKey === "acp:codex" ? profile.model : undefined,
      // Speckit chat: the agent runs as the authenticated user within the
      // project's working directory (a bind-mount the user owns). We trust
      // the user to drive their own writes — Anthropic's tool-permission
      // model on top of the proxy already enforces what the *credential*
      // can do. claude-agent-acp 0.33.1 forwards permission requests to
      // the client regardless of --allow-dangerously-skip-permissions, so
      // explicit auto-approve is required for Write/Edit/Bash to land.
      permissionMode: "auto-approve",
    });
  };
}
