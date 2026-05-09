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
  } else if (input.provider === "openai") {
    env.OPENAI_API_KEY = input.apiKey;
    if (input.baseUrl) env.OPENAI_BASE_URL = input.baseUrl;
  } else if (input.provider === "openrouter") {
    env.OPENAI_API_KEY = input.apiKey;
    env.OPENAI_BASE_URL = input.baseUrl || "https://openrouter.ai/api/v1";
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

  let env: Record<string, string>;
  if (profile.credential.mode === "api_key") {
    env = envForApiKey({
      provider: profile.provider,
      apiKey: profile.credential.apiKey,
      baseUrl: profile.credential.baseUrl,
      model: profile.model,
      runnerKey: profile.runnerKey,
    });
  } else {
    const proxyUrl =
      profile.credential.baseUrl || input.runtimeConfig?.companyClaudeProxyUrl || "";
    if (!proxyUrl) {
      throw createError({
        statusCode: 400,
        statusMessage: "Claude OAuth credentials require COMPANY_CLAUDE_PROXY_URL.",
      });
    }
    const session = await mintRunnerSession({
      userId: input.userId,
      owner: {
        kind: profile.credential.ownerKind,
        id: profile.credential.ownerId,
      },
    });
    env = {
      SPECIFYR_LLM_PROVIDER: profile.provider,
      SPECIFYR_LLM_MODEL: profile.model,
      SPECIFYR_AGENT_RUNNER: profile.runnerKey,
      ANTHROPIC_BASE_URL: proxyUrl,
      ANTHROPIC_API_KEY: session.token,
    };
  }

  const args = interpolateArgs(acpConfig.args ?? [], {
    model: profile.model,
    provider: profile.provider,
    runner: profile.runnerKey,
  });

  return ({ cwd, onEvent }: { cwd: string; onEvent?: (e: unknown) => void }) =>
    new AcpRunner({
      binary: acpConfig.binary!,
      args,
      cwd,
      env,
      memoryRoot: path.join(cwd, ".specifyr", "agent-memory", acpName),
      onEvent,
    });
}
