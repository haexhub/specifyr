<script setup lang="ts">
import { KeyRound } from "lucide-vue-next";
import type {
  CredentialRow,
  LlmProvider as Provider,
  ProviderMeta,
} from "~/components/LlmCredentialCard.vue";

interface OrgLlmResponse {
  org: { id: string; slug: string; name: string };
  myRole: "admin" | "member";
  credentials: CredentialRow[];
}

const providerMeta: Record<Provider, ProviderMeta> = {
  anthropic: {
    name: "Anthropic (Claude)",
    keyHint: "sk-ant-…",
  },
  openai: {
    name: "OpenAI",
    keyHint: "sk-…",
    baseUrlHint: "https://api.openai.com/v1",
  },
  google: {
    name: "Google (Gemini)",
    keyHint: "AIza…",
  },
  openrouter: {
    name: "OpenRouter",
    keyHint: "sk-or-…",
    baseUrlHint: "https://openrouter.ai/api/v1",
    baseUrlPrefill: "https://openrouter.ai/api/v1",
    hint: "Single key fronts many model families. Agents pick e.g. anthropic/claude-sonnet-4-5 or openai/gpt-5.",
  },
};
const providers: Provider[] = ["anthropic", "openai", "google", "openrouter"];

const route = useRoute();
const slug = computed(() => String(route.params.slug));
const endpoint = computed(() => `/api/orgs/${slug.value}/llm-credentials`);

const { data, refresh } = await useFetch<OrgLlmResponse>(
  () => endpoint.value,
);

const credsByProvider = computed(() => {
  const grouped: Record<Provider, CredentialRow[]> = {
    anthropic: [],
    openai: [],
    google: [],
    openrouter: [],
  };
  for (const c of data.value?.credentials ?? []) {
    grouped[c.provider]?.push(c);
  }
  return grouped;
});

const anthropicOauth = computed(
  () =>
    (data.value?.credentials ?? []).find(
      (c) => c.provider === "anthropic" && c.mode === "oauth_claude",
    ) ?? null,
);

const readOnly = computed(() => data.value?.myRole !== "admin");
</script>

<template>
  <div class="mx-auto w-full max-w-3xl px-6 py-8">
    <NuxtLink
      v-if="data"
      :to="`/settings/orgs/${data.org.slug}`"
      class="text-xs text-muted-foreground hover:text-foreground"
    >
      ← {{ data.org.name }}
    </NuxtLink>

    <h1 class="mt-2 flex items-center gap-2 text-2xl font-semibold">
      <KeyRound class="size-6 opacity-80" />
      Org LLM credentials
    </h1>
    <p class="mt-1 text-sm text-muted-foreground">
      Members of this org without their own personal credential will fall back
      to the keys configured here when they run agents on org-owned projects.
      <template v-if="readOnly">
        Only org admins can edit these.
      </template>
    </p>

    <template v-if="data">
      <AnthropicOAuthCard
        :existing="
          anthropicOauth
            ? {
                id: anthropicOauth.id,
                oauthStatus: anthropicOauth.oauthStatus,
              }
            : null
        "
        :endpoint="`${endpoint}/oauth/anthropic`"
        :delete-endpoint="endpoint"
        :read-only="readOnly"
        @changed="refresh()"
      />

      <LlmCredentialCard
        v-for="provider in providers"
        :key="provider"
        :provider="provider"
        :meta="providerMeta[provider]"
        :credentials="credsByProvider[provider] ?? []"
        :endpoint="endpoint"
        :read-only="readOnly"
        :default-display-name="data.org.name"
        @changed="refresh()"
      />
    </template>
    <p v-else class="mt-4 text-sm text-muted-foreground">Loading…</p>
  </div>
</template>
