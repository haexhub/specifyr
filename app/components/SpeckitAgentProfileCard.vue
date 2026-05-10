<script lang="ts">
import type { CredentialRow, LlmProvider } from "~/components/LlmCredentialCard.vue";

export type SpeckitRunnerKey = "acp:claude" | "acp:codex";

export interface SpeckitAgentProfile {
  id: string;
  ownerKind: "user" | "org";
  ownerId: string;
  purpose: "speckit";
  runnerKey: SpeckitRunnerKey;
  provider: LlmProvider;
  model: string;
  credentialId: string | null;
  createdAt: string;
  updatedAt: string;
}

// Each ACP agent speaks one wire protocol; "compatible" providers route to
// the same agent via base-URL override (e.g. OpenRouter → codex-acp via
// OPENAI_BASE_URL). The validator in llm-agent-profiles-store.ts mirrors
// this mapping.
const PROVIDER_TO_RUNNER: Record<"anthropic" | "openai" | "openrouter", SpeckitRunnerKey> = {
  anthropic: "acp:claude",
  openai: "acp:codex",
  openrouter: "acp:codex",
};
</script>

<script setup lang="ts">
import { Bot, Save } from "lucide-vue-next";
import ModelSelect from "~/components/ModelSelect.vue";
import { Button } from "~/components/shadcn/button";

const props = defineProps<{
  profile: SpeckitAgentProfile | null;
  credentials: CredentialRow[];
  endpoint: string;
  // Base path for credentials, used to build the /<id>/models URL.
  // Personal: "/api/me/llm-credentials".
  // Org:     "/api/orgs/<slug>/llm-credentials".
  credentialsEndpoint: string;
  readOnly?: boolean;
}>();

const emit = defineEmits<{
  changed: [];
}>();

type SpeckitProvider = "anthropic" | "openai" | "openrouter";

const recommendedProviders: Array<{ value: SpeckitProvider; label: string }> = [
  { value: "openai", label: "OpenAI / GPT" },
  { value: "anthropic", label: "Anthropic / Claude" },
];
const experimentalProviders: Array<{ value: SpeckitProvider; label: string }> = [
  { value: "openrouter", label: "OpenRouter" },
];

interface FormState {
  provider: SpeckitProvider;
  model: string;
  credentialId: string;
}

function fromProfile(profile: SpeckitAgentProfile | null): FormState {
  if (!profile) return { provider: "openai", model: "", credentialId: "" };
  return {
    provider: profile.provider as SpeckitProvider,
    model: profile.model,
    credentialId: profile.credentialId ?? "",
  };
}

const form = reactive<FormState>(fromProfile(props.profile));
const saving = ref(false);
const error = ref<string | null>(null);

const matchingCredentials = computed(() =>
  props.credentials.filter((c) => c.provider === form.provider && c.enabled),
);

watch(
  () => props.profile,
  (profile) => Object.assign(form, fromProfile(profile)),
);

watch(
  () => form.provider,
  () => {
    if (!matchingCredentials.value.some((c) => c.id === form.credentialId)) {
      form.credentialId = matchingCredentials.value[0]?.id ?? "";
      form.model = "";
    }
  },
);

async function save() {
  saving.value = true;
  error.value = null;
  try {
    await $fetch(props.endpoint, {
      method: "PUT",
      body: {
        runnerKey: PROVIDER_TO_RUNNER[form.provider],
        provider: form.provider,
        model: form.model.trim(),
        credentialId: form.credentialId || null,
      },
    });
    emit("changed");
  } catch (err: unknown) {
    error.value =
      (err as { statusMessage?: string })?.statusMessage ??
      (err instanceof Error ? err.message : "could not save");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="mt-8 rounded-lg border border-border">
    <header class="border-b border-border bg-muted/30 px-4 py-3">
      <h2 class="flex items-center gap-2 font-medium">
        <Bot class="size-4" /> Speckit workflow agent
      </h2>
      <p class="mt-0.5 text-xs text-muted-foreground">
        Used for Constitution, Specify, Plan, Tasks, and Implement runs.
      </p>
    </header>

    <form class="grid gap-3 px-4 py-4 md:grid-cols-2" @submit.prevent="save">
      <label class="block">
        <span class="text-xs font-medium">Provider</span>
        <select
          v-model="form.provider"
          class="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          :disabled="readOnly || saving"
        >
          <optgroup label="Recommended">
            <option v-for="p in recommendedProviders" :key="p.value" :value="p.value">
              {{ p.label }}
            </option>
          </optgroup>
          <optgroup label="Compatible (experimental)">
            <option v-for="p in experimentalProviders" :key="p.value" :value="p.value">
              {{ p.label }}
            </option>
          </optgroup>
        </select>
        <p v-if="form.provider === 'openrouter'" class="mt-1 text-xs text-muted-foreground">
          Routes via the Codex agent to any OpenAI-compatible model. Coding
          quality depends on the model's tool-use support — GPT-4-class or
          Claude-class models recommended.
        </p>
      </label>

      <label class="block">
        <span class="text-xs font-medium">Credential</span>
        <select
          v-model="form.credentialId"
          class="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          :disabled="readOnly || saving"
        >
          <option value="">Select a credential</option>
          <option v-for="credential in matchingCredentials" :key="credential.id" :value="credential.id">
            {{ credential.displayName }} · {{ credential.mode }}
          </option>
        </select>
      </label>

      <ModelSelect
        v-model="form.model"
        class="md:col-span-2"
        :credentials-endpoint="credentialsEndpoint"
        :credential-id="form.credentialId"
        :disabled="readOnly || saving"
      />

      <p v-if="error" class="md:col-span-2 text-sm text-destructive">{{ error }}</p>

      <div v-if="!readOnly" class="md:col-span-2">
        <Button type="submit" size="sm" :disabled="saving || !form.model.trim() || !form.credentialId">
          <Save class="size-4" /> {{ saving ? "Saving…" : "Save agent" }}
        </Button>
      </div>
    </form>
  </section>
</template>
