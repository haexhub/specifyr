<script lang="ts">
export type LlmProvider = "anthropic" | "openai" | "google" | "openrouter";

export interface CredentialRow {
  id: string;
  ownerKind: "user" | "org";
  ownerId: string;
  provider: LlmProvider;
  mode: "api_key" | "oauth_claude";
  displayName: string;
  hasKey: boolean;
  baseUrl: string | null;
  enabled: boolean;
  oauthStatus: "pending" | "authorized" | "expired" | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderMeta {
  name: string;
  keyHint: string;
  baseUrlHint?: string;
  baseUrlPrefill?: string;
  hint?: string;
}
</script>

<script setup lang="ts">
import { Eye, EyeOff, Plus, Trash2 } from "lucide-vue-next";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

const props = defineProps<{
  provider: LlmProvider;
  meta: ProviderMeta;
  credentials: CredentialRow[];
  // Base path for the API. Personal: "/api/me/llm-credentials".
  // Org: "/api/orgs/<slug>/llm-credentials".
  endpoint: string;
  // Read-only mode hides Add/Toggle/Delete buttons (org members who
  // aren't admins).
  readOnly?: boolean;
  // Default value for displayName field on the create form.
  defaultDisplayName?: string;
}>();

const emit = defineEmits<{
  changed: [];
}>();

const formOpen = ref(false);
const form = reactive({
  displayName: props.defaultDisplayName ?? "Default",
  apiKey: "",
  baseUrl: "",
});
const showKey = ref(false);
const submitting = ref(false);
const formError = ref<string | null>(null);

function openForm() {
  form.displayName = props.defaultDisplayName ?? "Default";
  form.apiKey = "";
  form.baseUrl = props.meta.baseUrlPrefill ?? "";
  showKey.value = false;
  formError.value = null;
  formOpen.value = true;
}

function closeForm() {
  formOpen.value = false;
  formError.value = null;
}

async function submit() {
  submitting.value = true;
  formError.value = null;
  try {
    await $fetch(props.endpoint, {
      method: "POST",
      body: {
        provider: props.provider,
        displayName: form.displayName.trim(),
        apiKey: form.apiKey,
        baseUrl: form.baseUrl.trim() || undefined,
      },
    });
    closeForm();
    emit("changed");
  } catch (err: unknown) {
    formError.value =
      (err as { statusMessage?: string })?.statusMessage ??
      (err instanceof Error ? err.message : "could not save");
  } finally {
    submitting.value = false;
  }
}

async function toggleEnabled(c: CredentialRow) {
  await $fetch(`${props.endpoint}/${c.id}`, {
    method: "PATCH",
    body: { enabled: !c.enabled },
  });
  emit("changed");
}

async function remove(c: CredentialRow) {
  if (
    !confirm(`Delete "${c.displayName}" credential for ${props.meta.name}?`)
  ) {
    return;
  }
  await $fetch(`${props.endpoint}/${c.id}`, { method: "DELETE" });
  emit("changed");
}
</script>

<template>
  <section class="mt-8 rounded-lg border border-border">
    <header
      class="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3"
    >
      <div>
        <h2 class="font-medium">{{ meta.name }}</h2>
        <p v-if="meta.hint" class="mt-0.5 text-xs text-muted-foreground">
          {{ meta.hint }}
        </p>
      </div>
      <Button
        v-if="!readOnly && !formOpen"
        size="sm"
        variant="outline"
        @click="openForm()"
      >
        <Plus class="size-4" /> Add key
      </Button>
    </header>

    <form
      v-if="formOpen"
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
            :placeholder="meta.keyHint"
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
      <label v-if="meta.baseUrlHint" class="block">
        <span class="text-xs font-medium">Base URL</span>
        <Input
          v-model="form.baseUrl"
          :placeholder="meta.baseUrlHint"
          :disabled="submitting"
          class="mt-1"
        />
      </label>
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
        v-for="c in credentials"
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
            {{ c.hasKey ? "key set" : "no key" }}
            <template v-if="c.baseUrl"> · {{ c.baseUrl }}</template>
            · added {{ new Date(c.createdAt).toLocaleDateString() }}
          </div>
        </div>
        <template v-if="!readOnly">
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
        </template>
      </li>
      <li
        v-if="credentials.length === 0 && !formOpen"
        class="px-4 py-6 text-center text-xs text-muted-foreground"
      >
        No keys yet.
      </li>
    </ul>
  </section>
</template>
