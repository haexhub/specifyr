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
</script>

<script setup lang="ts">
import { Bot, Save } from "lucide-vue-next";
import { Button } from "~/components/shadcn/button";
import { Input } from "~/components/shadcn/input";

const props = defineProps<{
  profile: SpeckitAgentProfile | null;
  credentials: CredentialRow[];
  endpoint: string;
  readOnly?: boolean;
}>();

const emit = defineEmits<{
  changed: [];
}>();

const runnerOptions: Array<{ value: SpeckitRunnerKey; label: string; provider: LlmProvider }> = [
  { value: "acp:codex", label: "Codex ACP", provider: "openai" },
  { value: "acp:claude", label: "Claude ACP", provider: "anthropic" },
];

const providerOptions: Array<{ value: LlmProvider; label: string }> = [
  { value: "openai", label: "OpenAI / GPT" },
  { value: "anthropic", label: "Anthropic / Claude" },
];

const form = reactive({
  runnerKey: "acp:codex" as SpeckitRunnerKey,
  provider: "openai" as LlmProvider,
  model: "gpt-5.2-codex",
  credentialId: "",
});
const saving = ref(false);
const error = ref<string | null>(null);

const matchingCredentials = computed(() =>
  props.credentials.filter((c) => c.provider === form.provider && c.enabled),
);

watch(
  () => props.profile,
  (profile) => {
    if (!profile) return;
    form.runnerKey = profile.runnerKey;
    form.provider = profile.provider;
    form.model = profile.model;
    form.credentialId = profile.credentialId ?? "";
  },
  { immediate: true },
);

watch(
  () => form.runnerKey,
  (runnerKey) => {
    const opt = runnerOptions.find((r) => r.value === runnerKey);
    if (opt && form.provider !== opt.provider) {
      form.provider = opt.provider;
      form.credentialId = "";
      if (opt.provider === "anthropic" && form.model === "gpt-5.2-codex") {
        form.model = "claude-sonnet-4-5";
      }
      if (opt.provider === "openai" && form.model.startsWith("claude-")) {
        form.model = "gpt-5.2-codex";
      }
    }
  },
);

watch(
  () => form.provider,
  () => {
    if (!matchingCredentials.value.some((c) => c.id === form.credentialId)) {
      form.credentialId = matchingCredentials.value[0]?.id ?? "";
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
        runnerKey: form.runnerKey,
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
        <span class="text-xs font-medium">Runner</span>
        <select
          v-model="form.runnerKey"
          class="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          :disabled="readOnly || saving"
        >
          <option v-for="runner in runnerOptions" :key="runner.value" :value="runner.value">
            {{ runner.label }}
          </option>
        </select>
      </label>

      <label class="block">
        <span class="text-xs font-medium">Provider</span>
        <select
          v-model="form.provider"
          class="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          :disabled="readOnly || saving"
        >
          <option v-for="provider in providerOptions" :key="provider.value" :value="provider.value">
            {{ provider.label }}
          </option>
        </select>
      </label>

      <label class="block">
        <span class="text-xs font-medium">Model</span>
        <Input v-model="form.model" class="mt-1" :disabled="readOnly || saving" />
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

      <p v-if="error" class="md:col-span-2 text-sm text-destructive">{{ error }}</p>

      <div v-if="!readOnly" class="md:col-span-2">
        <Button type="submit" size="sm" :disabled="saving || !form.model.trim() || !form.credentialId">
          <Save class="size-4" /> {{ saving ? "Saving…" : "Save agent" }}
        </Button>
      </div>
    </form>
  </section>
</template>
