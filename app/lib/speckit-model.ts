import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

import type { ProviderIdentity } from "~/stores/provider-identity";
import type { LanguageModel } from "ai";

/**
 * Resolve a `ProviderIdentity` to a Vercel-AI-SDK `LanguageModel`.
 * Browser-side only — each provider package is called with the user's
 * own API key (which never reaches our server) and any per-identity
 * base URL.
 *
 * Anthropic-direct calls require the explicit dangerous-direct-browser-
 * access header. The user already opted into browser-side execution
 * by configuring an identity, and our CSP whitelists the four
 * provider hosts.
 *
 * OpenRouter is exposed via the OpenAI-compatible adapter pointed at
 * openrouter.ai/api/v1 — they don't ship a dedicated AI-SDK package
 * we depend on, and the OpenAI-compat surface covers our needs.
 */
export function buildLanguageModel(identity: ProviderIdentity): LanguageModel {
  switch (identity.provider) {
    case "anthropic": {
      const provider = createAnthropic({
        apiKey: identity.apiKey,
        baseURL: identity.baseUrl,
        headers: { "anthropic-dangerous-direct-browser-access": "true" },
      });
      return provider(identity.model);
    }
    case "openai": {
      const provider = createOpenAI({
        apiKey: identity.apiKey,
        baseURL: identity.baseUrl,
      });
      return provider(identity.model);
    }
    case "google": {
      const provider = createGoogleGenerativeAI({
        apiKey: identity.apiKey,
        baseURL: identity.baseUrl,
      });
      return provider(identity.model);
    }
    case "openrouter": {
      const provider = createOpenAI({
        apiKey: identity.apiKey,
        baseURL: identity.baseUrl ?? "https://openrouter.ai/api/v1",
      });
      return provider(identity.model);
    }
    default: {
      // Persisted identity is in an unknown shape (corrupted localStorage,
      // future-provider rollback). Surface immediately rather than
      // returning undefined and tripping the AI SDK with a confusing
      // downstream error.
      const _exhaustive: never = identity.provider;
      throw new Error(
        `Unknown provider for identity "${identity.label}": ${_exhaustive}`,
      );
    }
  }
}
