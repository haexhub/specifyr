<script setup lang="ts">
import { Eye, EyeOff, KeyRound, Plus, Trash2 } from "lucide-vue-next";
import { Button } from "~/components/shadcn/button";
import { Input } from "~/components/shadcn/input";

interface OrgSecretsResponse {
  org: { id: string; slug: string; name: string };
  myRole: "admin" | "member";
  keys: string[];
}

const route = useRoute();
const slug = computed(() => String(route.params.slug));
const endpoint = computed(() => `/api/orgs/${slug.value}/secrets`);

const { data, refresh } = await useFetch<OrgSecretsResponse>(() => endpoint.value);
const keys = computed(() => data.value?.keys ?? []);
const readOnly = computed(() => data.value?.myRole !== "admin");

const newKey = ref("");
const newValue = ref("");
const showValue = ref(false);
const adding = ref(false);
const error = ref<string | null>(null);

function sanitizeKey(v: string): string {
  return v.toUpperCase().replace(/\s+/g, "_").replace(/[^A-Z0-9_]/g, "");
}

async function removeSecret(key: string) {
  error.value = null;
  try {
    await $fetch(`${endpoint.value}/${encodeURIComponent(key)}`, { method: "DELETE" });
    await refresh();
  } catch (e: any) {
    error.value = e?.data?.statusMessage ?? "Failed to delete secret.";
  }
}

async function addSecret() {
  error.value = null;
  const key = sanitizeKey(newKey.value.trim());
  if (!key || !newValue.value) {
    error.value = "Key and value are required.";
    return;
  }
  adding.value = true;
  try {
    await $fetch(endpoint.value, {
      method: "POST",
      body: { key, value: newValue.value },
    });
    newKey.value = "";
    newValue.value = "";
    await refresh();
  } catch (e: any) {
    error.value = e?.data?.statusMessage ?? "Failed to save secret.";
  } finally {
    adding.value = false;
  }
}
</script>

<template>
  <div>
    <NuxtLink
      v-if="data"
      :to="`/settings/orgs/${data.org.slug}`"
      class="text-xs text-muted-foreground hover:text-foreground"
    >
      ← {{ data.org.name }}
    </NuxtLink>

    <template v-if="data">
      <h1 class="mt-2 flex items-center gap-2 text-2xl font-semibold">
        <KeyRound class="size-6 opacity-80" />
        Org secrets
      </h1>
      <p class="mt-1 text-sm text-muted-foreground">
        Stored encrypted; available as environment variables only to agents that
        explicitly declare the key in their <code>secrets:</code> list.
        Project-level secrets with the same key override values defined here.
        <template v-if="readOnly">Only org admins can edit these.</template>
      </p>

      <section class="mt-8">
        <h2 class="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Stored secrets ({{ keys.length }})
        </h2>
        <p v-if="keys.length === 0" class="mt-3 text-sm text-muted-foreground">
          No org-level secrets configured yet.
        </p>
        <ul
          v-else
          class="mt-3 divide-y divide-border rounded-lg border border-border"
        >
          <li
            v-for="key in keys"
            :key="key"
            class="flex items-center justify-between gap-3 px-4 py-3"
          >
            <div class="flex items-center gap-2">
              <span class="font-mono text-sm">{{ key }}</span>
              <span class="text-xs text-muted-foreground">••••••••</span>
            </div>
            <Button
              v-if="!readOnly"
              size="sm"
              variant="ghost"
              :aria-label="`Delete secret ${key}`"
              class="text-destructive hover:bg-destructive/10"
              @click="removeSecret(key)"
            >
              <Trash2 class="size-3.5" />
            </Button>
          </li>
        </ul>
      </section>

      <section v-if="!readOnly" class="mt-8">
        <h2 class="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Add org secret
        </h2>
        <div class="mt-3 flex gap-2">
          <Input
            v-model="newKey"
            placeholder="KEY_NAME"
            class="flex-1 font-mono text-sm"
            @update:model-value="(v) => (newKey = sanitizeKey(String(v)))"
            @keydown.enter="addSecret"
          />
          <div class="relative flex-1">
            <Input
              v-model="newValue"
              :type="showValue ? 'text' : 'password'"
              placeholder="value"
              class="pr-10"
              @keydown.enter="addSecret"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              :aria-label="showValue ? 'Hide secret value' : 'Show secret value'"
              :aria-pressed="showValue"
              class="absolute right-1 top-1/2 -translate-y-1/2 size-8 text-muted-foreground hover:text-foreground"
              @click="showValue = !showValue"
            >
              <Eye v-if="!showValue" class="size-5" />
              <EyeOff v-else class="size-5" />
            </Button>
          </div>
          <Button :disabled="adding" @click="addSecret">
            <Plus class="size-4" />
            Add
          </Button>
        </div>
        <p v-if="error" class="mt-2 text-xs text-destructive">{{ error }}</p>
      </section>
    </template>
  </div>
</template>
