<script setup lang="ts">
definePageMeta({ layout: "workspace" });

import { Building2 } from "lucide-vue-next";

// onboarding-gate.global middleware handles both directions:
// users without memberships are redirected here, users WITH
// memberships are bounced back to /. No in-page guard needed.
const { refresh } = useMe();

const name = ref("");
const submitting = ref(false);
const error = ref<string | null>(null);

async function submit() {
  const trimmed = name.value.trim();
  if (!trimmed) {
    error.value = "Pick a name to get started.";
    return;
  }
  submitting.value = true;
  error.value = null;
  let org: { slug: string };
  try {
    org = await $fetch<{ slug: string }>("/api/orgs", {
      method: "POST",
      body: { name: trimmed },
    });
  } catch (err: unknown) {
    error.value =
      (err as { statusMessage?: string })?.statusMessage ??
      (err instanceof Error ? err.message : "Could not create org.");
    submitting.value = false;
    return;
  }
  // Org was created — refresh failure must not surface as "create
  // failed" (which prompts the user to retry and create a duplicate).
  try {
    await refresh();
  } catch {
    // Local /me cache out of sync; the destination page will refetch.
  }
  await navigateTo(`/settings/orgs/${encodeURIComponent(org.slug)}`);
  submitting.value = false;
}
</script>

<template>
  <div class="mx-auto w-full max-w-md px-6 py-12">
    <div class="rounded-lg border border-border bg-card p-6">
      <div class="flex items-start gap-3">
        <Building2 class="mt-1 size-6 shrink-0 opacity-80" />
        <div>
          <h1 class="text-xl font-semibold">Create your workspace</h1>
          <p class="mt-1 text-sm text-muted-foreground">
            Every project belongs to an organization. Pick a name — you can
            invite teammates later, or keep this as your personal workspace.
          </p>
        </div>
      </div>

      <form class="mt-5 space-y-3" @submit.prevent="submit">
        <label class="block text-sm">
          <span class="font-medium">Organization name</span>
          <ShadcnInput
            v-model="name"
            class="mt-1"
            placeholder="Acme Inc"
            :disabled="submitting"
            autofocus
          />
        </label>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <ShadcnButton type="submit" class="w-full" :disabled="submitting">
          {{ submitting ? "Creating…" : "Create workspace" }}
        </ShadcnButton>
      </form>
    </div>
  </div>
</template>
