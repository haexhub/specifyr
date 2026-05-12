import type { LlmCredential } from "@db/schema";
import { decryptString } from "./secrets-store";

export type ProviderId = "anthropic" | "openai" | "google" | "openrouter";

export type ModelChoice = {
  id: string;
  label: string;
};

type CacheEntry = {
  expires: number;
  models: ModelChoice[];
};

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function cacheKey(provider: ProviderId, credentialId: string): string {
  return `${provider}:${credentialId}`;
}

function defaultBaseUrl(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      return "https://api.openai.com";
    case "anthropic":
      return "https://api.anthropic.com";
    case "google":
      return "https://generativelanguage.googleapis.com";
    case "openrouter":
      return "https://openrouter.ai/api";
  }
}

function joinUrl(base: string, path: string): string {
  let trimmed = base.replace(/\/+$/, "");
  // Tolerate base URLs that already include the API version segment
  // (e.g. users pasting "https://openrouter.ai/api/v1" from the docs).
  // Without this, joinUrl would produce ".../v1/v1/models" and 404.
  const versionMatch = path.match(/^\/(v\d+[a-z]*)\//);
  if (versionMatch && trimmed.endsWith(`/${versionMatch[1]}`)) {
    trimmed = trimmed.slice(0, -versionMatch[1].length - 1);
  }
  return `${trimmed}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function getApiKey(credential: LlmCredential): Promise<string> {
  if (credential.mode !== "api_key") {
    throw createError({
      statusCode: 400,
      statusMessage:
        "Cannot list models for OAuth credentials. Add an API-key credential to enable automatic model selection.",
    });
  }
  if (!credential.apiKeyIv || !credential.apiKeyTag || !credential.apiKeyData) {
    throw createError({ statusCode: 400, statusMessage: "Credential is missing its API key." });
  }
  return decryptString({
    iv: credential.apiKeyIv,
    tag: credential.apiKeyTag,
    data: credential.apiKeyData,
  });
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    throw createError({
      statusCode: 502,
      statusMessage: `Could not reach provider: ${(err as Error).message}`,
    });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw createError({
      statusCode: 502,
      statusMessage: `Provider returned ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
    });
  }
  return (await response.json()) as T;
}

async function listOpenAi(credential: LlmCredential): Promise<ModelChoice[]> {
  const key = await getApiKey(credential);
  const base = credential.baseUrl ?? defaultBaseUrl("openai");
  const data = await fetchJson<{ data?: Array<{ id: string }> }>(joinUrl(base, "/v1/models"), {
    headers: { Authorization: `Bearer ${key}` },
  });
  const models = (data.data ?? [])
    .map((m) => ({ id: m.id, label: m.id }))
    .filter((m) => m.id);
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

// Curated fallback for `oauth_claude` credentials: Anthropic's /v1/models
// requires an API key, and OAuth credentials only carry CLI tokens on disk.
// Listed in newest-first order — tweak when new model families ship.
const ANTHROPIC_OAUTH_MODELS: ModelChoice[] = [
  { id: "claude-opus-4-7", label: "Claude Opus 4.7 (claude-opus-4-7)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (claude-sonnet-4-6)" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (claude-haiku-4-5)" },
];

async function listAnthropic(credential: LlmCredential): Promise<ModelChoice[]> {
  if (credential.mode === "oauth_claude") return ANTHROPIC_OAUTH_MODELS;
  const key = await getApiKey(credential);
  const base = credential.baseUrl ?? defaultBaseUrl("anthropic");
  const data = await fetchJson<{
    data?: Array<{ id: string; display_name?: string }>;
  }>(joinUrl(base, "/v1/models"), {
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
  });
  const models = (data.data ?? [])
    .map((m) => ({ id: m.id, label: m.display_name ? `${m.display_name} (${m.id})` : m.id }))
    .filter((m) => m.id);
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

async function listGoogle(credential: LlmCredential): Promise<ModelChoice[]> {
  const key = await getApiKey(credential);
  const base = credential.baseUrl ?? defaultBaseUrl("google");
  const data = await fetchJson<{
    models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>;
  }>(joinUrl(base, `/v1beta/models?key=${encodeURIComponent(key)}`), {});
  const models = (data.models ?? [])
    .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
    .map((m) => {
      const id = m.name.startsWith("models/") ? m.name.slice("models/".length) : m.name;
      return { id, label: m.displayName ? `${m.displayName} (${id})` : id };
    });
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

async function listOpenRouter(credential: LlmCredential): Promise<ModelChoice[]> {
  const key = await getApiKey(credential);
  const base = credential.baseUrl ?? defaultBaseUrl("openrouter");
  const data = await fetchJson<{
    data?: Array<{ id: string; name?: string }>;
  }>(joinUrl(base, "/v1/models"), {
    headers: { Authorization: `Bearer ${key}` },
  });
  const models = (data.data ?? [])
    .map((m) => ({ id: m.id, label: m.name ? `${m.name} (${m.id})` : m.id }))
    .filter((m) => m.id);
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

export async function listProviderModels(
  provider: ProviderId,
  credential: LlmCredential,
): Promise<ModelChoice[]> {
  const key = cacheKey(provider, credential.id);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.models;

  let models: ModelChoice[];
  switch (provider) {
    case "openai":
      models = await listOpenAi(credential);
      break;
    case "anthropic":
      models = await listAnthropic(credential);
      break;
    case "google":
      models = await listGoogle(credential);
      break;
    case "openrouter":
      models = await listOpenRouter(credential);
      break;
  }

  cache.set(key, { expires: now + TTL_MS, models });
  return models;
}

export function clearProviderModelsCache(credentialId?: string): void {
  if (!credentialId) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.endsWith(`:${credentialId}`)) cache.delete(key);
  }
}
