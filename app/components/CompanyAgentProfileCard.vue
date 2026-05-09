<script lang="ts">
import type { CredentialRow, LlmProvider } from "~/components/LlmCredentialCard.vue";

export interface CompanyAgentProfile {
  id: string;
  ownerKind: "user" | "org";
  ownerId: string;
  purpose: "company-agent";
  agentRole: string;
  runnerKey: "hermes";
  provider: LlmProvider;
  model: string;
  credentialId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMeta {
  role: string;
  description?: string;
  declaredModel?: string;
  capabilities: string[];
}
</script>

<script setup lang="ts">
import { Bot, Save, Trash2, Building2, User } from "lucide-vue-next";
import { Button } from "~/components/shadcn/button";
import { Input } from "~/components/shadcn/input";

const props = defineProps<{
  agent: AgentMeta;
  userProfile: CompanyAgentProfile | null;
  orgProfile: CompanyAgentProfile | null;
  effectiveScope: "user" | "org" | null;
  userCredentials: CredentialRow[];
  orgCredentials: CredentialRow[];
  // Endpoints for PUT/DELETE on this role.
  userEndpoint: string;        // e.g. /api/me/agent-profiles/company-agents/<role>
  orgEndpoint: string | null;  // null = project has no owning org with creds; org form is hidden
  canEditOrg: boolean;         // user is admin of project's owning org
}>();

const emit = defineEmits<{ changed: [] }>();

const providerOptions: Array<{ value: LlmProvider; label: string }> = [
  { value: "anthropic", label: "Anthropic / Claude" },
  { value: "openai", label: "OpenAI / GPT" },
  { value: "google", label: "Google / Gemini" },
  { value: "openrouter", label: "OpenRouter" },
];

interface FormState {
  provider: LlmProvider;
  model: string;
  credentialId: string;
}

function blankForm(): FormState {
  return { provider: "anthropic", model: "", credentialId: "" };
}

function fromProfile(profile: CompanyAgentProfile | null): FormState {
  if (!profile) return blankForm();
  return {
    provider: profile.provider,
    model: profile.model,
    credentialId: profile.credentialId ?? "",
  };
}

const userForm = reactive<FormState>(fromProfile(props.userProfile));
const orgForm = reactive<FormState>(fromProfile(props.orgProfile));

watch(
  () => props.userProfile,
  (p) => Object.assign(userForm, fromProfile(p)),
);
watch(
  () => props.orgProfile,
  (p) => Object.assign(orgForm, fromProfile(p)),
);

const userMatchingCreds = computed(() =>
  props.userCredentials.filter((c) => c.provider === userForm.provider && c.enabled),
);
const orgMatchingCreds = computed(() =>
  props.orgCredentials.filter((c) => c.provider === orgForm.provider && c.enabled),
);

watch(
  () => userForm.provider,
  () => {
    if (!userMatchingCreds.value.some((c) => c.id === userForm.credentialId)) {
      userForm.credentialId = userMatchingCreds.value[0]?.id ?? "";
    }
  },
);
watch(
  () => orgForm.provider,
  () => {
    if (!orgMatchingCreds.value.some((c) => c.id === orgForm.credentialId)) {
      orgForm.credentialId = orgMatchingCreds.value[0]?.id ?? "";
    }
  },
);

const userSaving = ref(false);
const orgSaving = ref(false);
const userError = ref<string | null>(null);
const orgError = ref<string | null>(null);

async function saveScope(scope: "user" | "org") {
  const form = scope === "user" ? userForm : orgForm;
  const endpoint = scope === "user" ? props.userEndpoint : props.orgEndpoint;
  if (!endpoint) return;
  const savingRef = scope === "user" ? userSaving : orgSaving;
  const errorRef = scope === "user" ? userError : orgError;
  savingRef.value = true;
  errorRef.value = null;
  try {
    await $fetch(endpoint, {
      method: "PUT",
      body: {
        runnerKey: "hermes",
        provider: form.provider,
        model: form.model.trim(),
        credentialId: form.credentialId || null,
      },
    });
    emit("changed");
  } catch (err: unknown) {
    errorRef.value =
      (err as { statusMessage?: string })?.statusMessage ??
      (err instanceof Error ? err.message : "could not save");
  } finally {
    savingRef.value = false;
  }
}

async function clearScope(scope: "user" | "org") {
  const endpoint = scope === "user" ? props.userEndpoint : props.orgEndpoint;
  if (!endpoint) return;
  if (!confirm(`Clear ${scope === "user" ? "personal" : "org"} profile for ${props.agent.role}?`)) return;
  const savingRef = scope === "user" ? userSaving : orgSaving;
  savingRef.value = true;
  try {
    await $fetch(endpoint, { method: "DELETE" });
    emit("changed");
  } catch (err: unknown) {
    const errorRef = scope === "user" ? userError : orgError;
    errorRef.value =
      (err as { statusMessage?: string })?.statusMessage ??
      (err instanceof Error ? err.message : "could not clear");
  } finally {
    savingRef.value = false;
  }
}
</script>

<template>
  <section class="rounded-lg border border-border">
    <header class="border-b border-border bg-muted/30 px-4 py-3">
      <h3 class="flex items-center gap-2 text-sm font-medium">
        <Bot class="size-4" /> {{ agent.role }}
        <span
          v-if="effectiveScope"
          class="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-primary"
        >
          active: {{ effectiveScope }}
        </span>
        <span
          v-else
          class="ml-2 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400"
        >
          no profile
        </span>
      </h3>
      <p v-if="agent.description" class="mt-0.5 text-xs text-muted-foreground line-clamp-2">
        {{ agent.description }}
      </p>
      <p v-if="agent.declaredModel" class="mt-1 text-xs text-muted-foreground">
        Spec default: <code>{{ agent.declaredModel }}</code>
      </p>
    </header>

    <!-- Personal override -->
    <div class="border-b border-border px-4 py-3">
      <p class="mb-2 flex items-center gap-1.5 text-xs font-medium">
        <User class="size-3.5" /> My override
      </p>
      <form class="grid gap-2 md:grid-cols-3" @submit.prevent="saveScope('user')">
        <label class="block">
          <span class="text-xs font-medium">Provider</span>
          <select
            v-model="userForm.provider"
            class="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            :disabled="userSaving"
          >
            <option v-for="p in providerOptions" :key="p.value" :value="p.value">{{ p.label }}</option>
          </select>
        </label>
        <label class="block">
          <span class="text-xs font-medium">Model</span>
          <Input v-model="userForm.model" class="mt-1" placeholder="e.g. claude-sonnet-4-5" :disabled="userSaving" />
        </label>
        <label class="block">
          <span class="text-xs font-medium">Credential</span>
          <select
            v-model="userForm.credentialId"
            class="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            :disabled="userSaving"
          >
            <option value="">Select a credential</option>
            <option v-for="c in userMatchingCreds" :key="c.id" :value="c.id">
              {{ c.displayName }} · {{ c.mode }}
            </option>
          </select>
        </label>

        <p v-if="userError" class="md:col-span-3 text-sm text-destructive">{{ userError }}</p>

        <div class="md:col-span-3 flex justify-end gap-2">
          <Button
            v-if="userProfile"
            type="button"
            variant="outline"
            size="sm"
            :disabled="userSaving"
            @click="clearScope('user')"
          >
            <Trash2 class="size-4" /> Clear
          </Button>
          <Button type="submit" size="sm" :disabled="userSaving || !userForm.model.trim() || !userForm.credentialId">
            <Save class="size-4" /> {{ userSaving ? "Saving…" : "Save my override" }}
          </Button>
        </div>
      </form>
    </div>

    <!-- Org default (only when project is org-owned) -->
    <div v-if="orgEndpoint" class="px-4 py-3">
      <p class="mb-2 flex items-center gap-1.5 text-xs font-medium">
        <Building2 class="size-3.5" /> Org default
        <span v-if="!canEditOrg" class="ml-2 text-[10px] text-muted-foreground">(admin only)</span>
      </p>
      <form class="grid gap-2 md:grid-cols-3" @submit.prevent="saveScope('org')">
        <label class="block">
          <span class="text-xs font-medium">Provider</span>
          <select
            v-model="orgForm.provider"
            class="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            :disabled="!canEditOrg || orgSaving"
          >
            <option v-for="p in providerOptions" :key="p.value" :value="p.value">{{ p.label }}</option>
          </select>
        </label>
        <label class="block">
          <span class="text-xs font-medium">Model</span>
          <Input v-model="orgForm.model" class="mt-1" placeholder="e.g. claude-sonnet-4-5" :disabled="!canEditOrg || orgSaving" />
        </label>
        <label class="block">
          <span class="text-xs font-medium">Credential</span>
          <select
            v-model="orgForm.credentialId"
            class="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            :disabled="!canEditOrg || orgSaving"
          >
            <option value="">Select a credential</option>
            <option v-for="c in orgMatchingCreds" :key="c.id" :value="c.id">
              {{ c.displayName }} · {{ c.mode }}
            </option>
          </select>
        </label>

        <p v-if="orgError" class="md:col-span-3 text-sm text-destructive">{{ orgError }}</p>

        <div v-if="canEditOrg" class="md:col-span-3 flex justify-end gap-2">
          <Button
            v-if="orgProfile"
            type="button"
            variant="outline"
            size="sm"
            :disabled="orgSaving"
            @click="clearScope('org')"
          >
            <Trash2 class="size-4" /> Clear
          </Button>
          <Button type="submit" size="sm" :disabled="orgSaving || !orgForm.model.trim() || !orgForm.credentialId">
            <Save class="size-4" /> {{ orgSaving ? "Saving…" : "Save org default" }}
          </Button>
        </div>
      </form>
    </div>
  </section>
</template>
