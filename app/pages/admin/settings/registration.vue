<script setup lang="ts">
definePageMeta({ layout: "workspace", middleware: ["platform-admin"] });

import { Settings } from "lucide-vue-next";

type Policy = "open" | "domain" | "closed";

interface SettingsResponse {
  registration: {
    policy: Policy;
    allowedDomains: string[];
  };
}

const { data, refresh, pending } = await useFetch<SettingsResponse>(
  "/api/admin/settings",
  {
    default: () => ({
      registration: { policy: "closed" as Policy, allowedDomains: [] },
    }),
  },
);

const policy = ref<Policy>(data.value.registration.policy);
const domainsText = ref(data.value.registration.allowedDomains.join("\n"));
const saving = ref(false);
const message = ref<string | null>(null);
const error = ref<string | null>(null);

// Form is locked while the initial settings fetch is pending or while
// a save is in flight. Without this gate the user could submit the
// fallback default ("closed") before the real settings ever arrived.
const formLocked = computed(() => pending.value || saving.value);

watch(data, (d) => {
  if (!d) return;
  policy.value = d.registration.policy;
  domainsText.value = d.registration.allowedDomains.join("\n");
});

async function save() {
  saving.value = true;
  message.value = null;
  error.value = null;
  try {
    const allowedDomains = domainsText.value
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    await $fetch("/api/admin/settings", {
      method: "PATCH",
      body: { registration: { policy: policy.value, allowedDomains } },
    });
    await refresh();
    message.value = "Saved.";
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
  <div>
    <nav class="flex flex-wrap gap-2 text-xs">
      <NuxtLink
        to="/admin/users"
        class="rounded-md px-3 py-1 text-muted-foreground hover:bg-muted"
      >
        Users
      </NuxtLink>
      <NuxtLink
        to="/admin/orgs"
        class="rounded-md px-3 py-1 text-muted-foreground hover:bg-muted"
      >
        Organizations
      </NuxtLink>
      <NuxtLink
        to="/admin/settings/registration"
        class="rounded-md bg-muted px-3 py-1 font-medium"
      >
        <Settings class="mr-1 inline size-3.5" /> Settings
      </NuxtLink>
    </nav>

    <h1 class="mt-4 text-2xl font-semibold">Self-registration policy</h1>
    <p class="mt-1 text-sm text-muted-foreground">
      Controls whether new users can sign in to specifyr after authenticating
      with the IDP. Existing users are never blocked by these rules.
    </p>

    <form class="mt-6 max-w-xl space-y-4 rounded-lg border border-border bg-muted/30 p-4" @submit.prevent="save">
      <div>
        <label class="text-sm font-medium">Policy</label>
        <select
          v-model="policy"
          class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          :disabled="formLocked"
        >
          <option value="open">Open — anyone with an IDP account can sign in</option>
          <option value="domain">Domain-restricted — only allowed email domains</option>
          <option value="closed">Closed — only invited users can sign in</option>
        </select>
      </div>

      <div v-if="policy === 'domain'">
        <label class="text-sm font-medium">Allowed email domains</label>
        <textarea
          v-model="domainsText"
          rows="4"
          class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
          placeholder="example.com&#10;another.org"
          :disabled="formLocked"
        />
        <p class="mt-1 text-xs text-muted-foreground">
          One per line, comma- or whitespace-separated. Lower-cased on save.
        </p>
      </div>

      <div class="flex items-center gap-3">
        <ShadcnButton type="submit" :disabled="formLocked">
          {{ saving ? "Saving…" : "Save settings" }}
        </ShadcnButton>
        <span v-if="message" class="text-sm text-primary">{{ message }}</span>
        <span v-if="error" class="text-sm text-destructive">{{ error }}</span>
      </div>
    </form>

    <p class="mt-6 text-xs text-muted-foreground">
      Invite redemptions ignore this policy by design — an org admin can
      onboard external collaborators even when the platform is "closed".
    </p>
  </div>
</template>
