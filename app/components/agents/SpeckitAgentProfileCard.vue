<script lang="ts">
import type { CredentialRow, LlmProvider } from "~/components/settings/LlmCredentialCard.vue";

export type SpeckitRunnerKey = "acp:claude" | "acp:codex" | "acp:gemini";

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

// Each ACP agent speaks one wire protocol; the speckit UI only offers the
// native providers per agent. OpenRouter is intentionally NOT listed here:
// codex-acp 0.0.43 ignores the model override and forces gpt-5.5 regardless
// of the selected OpenRouter slug, so exposing it was misleading. The backend
// validator still accepts `openrouter` so existing stored profiles don't
// crash and so a future generic Chat-Completions ACP runner can re-enable it.
const PROVIDER_TO_RUNNER: Record<
  "anthropic" | "openai" | "google",
  SpeckitRunnerKey
> = {
  anthropic: "acp:claude",
  openai: "acp:codex",
  google: "acp:gemini",
};
</script>

<script setup lang="ts">
import { Bot, Check } from "lucide-vue-next";
import ModelSelect from "~/components/settings/ModelSelect.vue";

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

type SpeckitProvider = "anthropic" | "openai" | "google";

const providers: Array<{ value: SpeckitProvider; label: string }> = [
  { value: "openai", label: "OpenAI / GPT" },
  { value: "anthropic", label: "Anthropic / Claude" },
  { value: "google", label: "Google / Gemini" },
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
const status = ref<"idle" | "saving" | "saved" | "error">("idle");
const error = ref<string | null>(null);
let lastSavedSnapshot = snapshot(form);
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let savedResetTimer: ReturnType<typeof setTimeout> | null = null;

function snapshot(s: FormState): string {
  return JSON.stringify({ p: s.provider, m: s.model.trim(), c: s.credentialId });
}

const matchingCredentials = computed(() =>
  props.credentials.filter((c) => c.provider === form.provider && c.enabled),
);

watch(
  () => props.profile,
  (profile) => {
    Object.assign(form, fromProfile(profile));
    lastSavedSnapshot = snapshot(form);
    status.value = "idle";
    error.value = null;
  },
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

watch(
  () => [form.provider, form.model, form.credentialId],
  () => {
    if (props.readOnly) return;
    if (snapshot(form) === lastSavedSnapshot) return;
    if (!form.model.trim() || !form.credentialId) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 600);
  },
);

async function save() {
  const current = snapshot(form);
  if (current === lastSavedSnapshot) return;
  status.value = "saving";
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
    lastSavedSnapshot = current;
    status.value = "saved";
    if (savedResetTimer) clearTimeout(savedResetTimer);
    savedResetTimer = setTimeout(() => {
      if (status.value === "saved") status.value = "idle";
    }, 2000);
    emit("changed");
  } catch (err: unknown) {
    status.value = "error";
    error.value =
      (err as { statusMessage?: string })?.statusMessage ??
      (err instanceof Error ? err.message : "could not save");
  }
}

onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer);
  if (savedResetTimer) clearTimeout(savedResetTimer);
});

const saving = computed(() => status.value === "saving");
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
          <option v-for="p in providers" :key="p.value" :value="p.value">
            {{ p.label }}
          </option>
        </select>
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

      <SettingsModelSelect
        v-model="form.model"
        class="md:col-span-2"
        :credentials-endpoint="credentialsEndpoint"
        :credential-id="form.credentialId"
        :disabled="readOnly || saving"
      />

      <p v-if="error" class="md:col-span-2 text-sm text-destructive">{{ error }}</p>

      <div v-if="!readOnly" class="md:col-span-2 flex items-center gap-2 text-xs text-muted-foreground min-h-5">
        <template v-if="status === 'saving'">
          <span class="inline-block size-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
          <span>Saving…</span>
        </template>
        <template v-else-if="status === 'saved'">
          <Check class="size-3.5 text-green-600" />
          <span>Saved</span>
        </template>
        <template v-else-if="!form.model.trim() || !form.credentialId">
          <span>Select a credential and model to enable autosave.</span>
        </template>
        <template v-else>
          <span>Changes save automatically.</span>
        </template>
      </div>
    </form>
  </section>
</template>
