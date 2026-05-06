<script setup lang="ts">
import { Eye, EyeOff, KeyRound, Plus, Trash2 } from "lucide-vue-next";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

type Provider = "anthropic" | "openai" | "google";
interface CredentialRow {
  id: string;
  ownerKind: "user" | "org";
  ownerId: string;
  provider: Provider;
  mode: "api_key" | "oauth_claude";
  displayName: string;
  hasKey: boolean;
  baseUrl: string | null;
  defaultModel: string | null;
  enabled: boolean;
  oauthStatus: "pending" | "authorized" | "expired" | null;
  createdAt: string;
  updatedAt: string;
}

const providerMeta: Record<
  Provider,
  { name: string; defaultModelHint: string; keyHint: string; baseUrlHint?: string }
> = {
  anthropic: {
    name: "Anthropic (Claude)",
    defaultModelHint: "claude-sonnet-4-6",
    keyHint: "sk-ant-…",
  },
  openai: {
    name: "OpenAI",
    defaultModelHint: "gpt-5",
    keyHint: "sk-…",
    baseUrlHint: "https://api.openai.com/v1",
  },
  google: {
    name: "Google (Gemini)",
    defaultModelHint: "gemini-2.5-pro",
    keyHint: "AIza…",
  },
};
const providers: Provider[] = ["anthropic", "openai", "google"];

const { data: credentials, refresh } = await useFetch<CredentialRow[]>(
  "/api/me/llm-credentials",
  { default: () => [] },
);

const credsByProvider = computed(() => {
  const grouped: Record<Provider, CredentialRow[]> = {
    anthropic: [],
    openai: [],
    google: [],
  };
  for (const c of credentials.value ?? []) {
    grouped[c.provider]?.push(c);
  }
  return grouped;
});

const formOpenFor = ref<Provider | null>(null);
const form = reactive({
  displayName: "Personal",
  apiKey: "",
  baseUrl: "",
  defaultModel: "",
});
const showKey = ref(false);
const submitting = ref(false);
const formError = ref<string | null>(null);

function openForm(provider: Provider) {
  formOpenFor.value = provider;
  form.displayName = "Personal";
  form.apiKey = "";
  form.baseUrl = "";
  form.defaultModel = "";
  showKey.value = false;
  formError.value = null;
}

function closeForm() {
  formOpenFor.value = null;
  formError.value = null;
}

async function submit() {
  if (!formOpenFor.value) return;
  submitting.value = true;
  formError.value = null;
  try {
    await $fetch("/api/me/llm-credentials", {
      method: "POST",
      body: {
        provider: formOpenFor.value,
        displayName: form.displayName.trim(),
        apiKey: form.apiKey,
        baseUrl: form.baseUrl.trim() || undefined,
        defaultModel: form.defaultModel.trim() || undefined,
      },
    });
    closeForm();
    await refresh();
  } catch (err: unknown) {
    formError.value =
      (err as { statusMessage?: string })?.statusMessage ??
      (err instanceof Error ? err.message : "could not save");
  } finally {
    submitting.value = false;
  }
}

async function toggleEnabled(c: CredentialRow) {
  await $fetch(`/api/me/llm-credentials/${c.id}`, {
    method: "PATCH",
    body: { enabled: !c.enabled },
  });
  await refresh();
}

async function remove(c: CredentialRow) {
  if (
    !confirm(`Delete "${c.displayName}" credential for ${providerMeta[c.provider].name}?`)
  ) {
    return;
  }
  await $fetch(`/api/me/llm-credentials/${c.id}`, { method: "DELETE" });
  await refresh();
}
</script>

<template>
  <div class="mx-auto w-full max-w-3xl px-6 py-8">
    <NuxtLink
      to="/settings"
      class="text-xs text-muted-foreground hover:text-foreground"
    >
      ← Settings
    </NuxtLink>

    <h1 class="mt-2 flex items-center gap-2 text-2xl font-semibold">
      <KeyRound class="size-6 opacity-80" />
      Personal LLM credentials
    </h1>
    <p class="mt-1 text-sm text-muted-foreground">
      API keys you add here are encrypted at rest and used by your agent runs.
      Org-shared credentials are managed under each org's settings.
    </p>

    <section
      v-for="provider in providers"
      :key="provider"
      class="mt-8 rounded-lg border border-border"
    >
      <header
        class="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3"
      >
        <div>
          <h2 class="font-medium">{{ providerMeta[provider].name }}</h2>
          <p class="mt-0.5 text-xs text-muted-foreground">
            Default model hint: {{ providerMeta[provider].defaultModelHint }}
          </p>
        </div>
        <Button
          v-if="formOpenFor !== provider"
          size="sm"
          variant="outline"
          @click="openForm(provider)"
        >
          <Plus class="size-4" /> Add key
        </Button>
      </header>

      <form
        v-if="formOpenFor === provider"
        class="space-y-3 border-b border-border bg-muted/10 px-4 py-3"
        @submit.prevent="submit"
      >
        <label class="block">
          <span class="text-xs font-medium">Display name</span>
          <Input v-model="form.displayName" class="mt-1" :disabled="submitting" />
        </label>
        <label class="block">
          <span class="text-xs font-medium">API key</span>
          <div class="mt-1 flex gap-2">
            <Input
              v-model="form.apiKey"
              :type="showKey ? 'text' : 'password'"
              :placeholder="providerMeta[provider].keyHint"
              :disabled="submitting"
              class="flex-1"
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              :title="showKey ? 'Hide' : 'Reveal'"
              @click="showKey = !showKey"
            >
              <EyeOff v-if="showKey" class="size-4" />
              <Eye v-else class="size-4" />
            </Button>
          </div>
          <p class="mt-1 text-[11px] text-muted-foreground">
            Stored AES-256-GCM encrypted; never returned by the API after save.
          </p>
        </label>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block">
            <span class="text-xs font-medium">Default model (optional)</span>
            <Input
              v-model="form.defaultModel"
              :placeholder="providerMeta[provider].defaultModelHint"
              :disabled="submitting"
              class="mt-1"
            />
          </label>
          <label v-if="providerMeta[provider].baseUrlHint" class="block">
            <span class="text-xs font-medium">Base URL (optional)</span>
            <Input
              v-model="form.baseUrl"
              :placeholder="providerMeta[provider].baseUrlHint"
              :disabled="submitting"
              class="mt-1"
            />
          </label>
        </div>
        <p v-if="formError" class="text-sm text-destructive">{{ formError }}</p>
        <div class="flex gap-2">
          <Button type="submit" size="sm" :disabled="submitting">
            {{ submitting ? "Saving…" : "Save" }}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            :disabled="submitting"
            @click="closeForm()"
          >
            Cancel
          </Button>
        </div>
      </form>

      <ul class="divide-y divide-border">
        <li
          v-for="c in credsByProvider[provider]"
          :key="c.id"
          class="flex items-center gap-3 px-4 py-3"
          :class="{ 'opacity-50': !c.enabled }"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium truncate">{{ c.displayName }}</span>
              <span
                class="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                {{ c.mode }}
              </span>
              <span
                v-if="!c.enabled"
                class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                disabled
              </span>
            </div>
            <div class="mt-0.5 truncate text-xs text-muted-foreground">
              {{ c.defaultModel ?? "—" }} ·
              {{ c.hasKey ? "key set" : "no key" }} ·
              added {{ new Date(c.createdAt).toLocaleDateString() }}
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            :title="c.enabled ? 'Disable' : 'Enable'"
            @click="toggleEnabled(c)"
          >
            {{ c.enabled ? "Disable" : "Enable" }}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            class="text-destructive hover:bg-destructive/10"
            title="Delete"
            @click="remove(c)"
          >
            <Trash2 class="size-4" />
          </Button>
        </li>
        <li
          v-if="credsByProvider[provider].length === 0 && formOpenFor !== provider"
          class="px-4 py-6 text-center text-xs text-muted-foreground"
        >
          No keys yet.
        </li>
      </ul>
    </section>
  </div>
</template>
