<script setup lang="ts">
import { Building2, ChevronRight, Plus } from "lucide-vue-next";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  role: "admin" | "member";
  createdAt: string;
}

const { data: orgs, refresh } = await useFetch<OrgRow[]>("/api/orgs", {
  default: () => [],
});

const showForm = ref(false);
const newName = ref("");
const submitting = ref(false);
const error = ref<string | null>(null);

async function createOrg() {
  error.value = null;
  if (newName.value.trim().length < 2) {
    error.value = "Name must be at least 2 characters.";
    return;
  }
  submitting.value = true;
  try {
    const created = await $fetch<OrgRow>("/api/orgs", {
      method: "POST",
      body: { name: newName.value.trim() },
    });
    newName.value = "";
    showForm.value = false;
    await refresh();
    await navigateTo(`/settings/orgs/${created.slug}`);
  } catch (err: unknown) {
    error.value =
      err instanceof Error
        ? err.message
        : (err as { statusMessage?: string })?.statusMessage ?? "could not create org";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div>
    <div class="mb-6 flex items-start justify-between gap-4">
      <div>
        <NuxtLink
          to="/settings"
          class="text-xs text-muted-foreground hover:text-foreground"
        >
          ← Settings
        </NuxtLink>
        <h1 class="mt-2 text-2xl font-semibold">Organizations</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Orgs let teams share LLM credentials. Anyone can create one.
        </p>
      </div>
      <Button v-if="!showForm" @click="showForm = true">
        <Plus class="size-4" /> New org
      </Button>
    </div>

    <form
      v-if="showForm"
      class="mb-6 rounded-lg border border-border bg-muted/30 p-4"
      @submit.prevent="createOrg"
    >
      <label class="block text-sm font-medium">Name</label>
      <Input
        v-model="newName"
        class="mt-1"
        placeholder="e.g. itemis"
        :disabled="submitting"
        autofocus
      />
      <p v-if="error" class="mt-2 text-sm text-destructive">{{ error }}</p>
      <div class="mt-3 flex gap-2">
        <Button type="submit" :disabled="submitting">
          {{ submitting ? "Creating…" : "Create" }}
        </Button>
        <Button
          type="button"
          variant="ghost"
          :disabled="submitting"
          @click="
            showForm = false;
            newName = '';
            error = null;
          "
        >
          Cancel
        </Button>
      </div>
    </form>

    <ul v-if="orgs && orgs.length" class="space-y-2">
      <li v-for="org in orgs" :key="org.id">
        <NuxtLink
          :to="`/settings/orgs/${org.slug}`"
          class="group flex items-center gap-3 rounded-lg border border-border p-4 transition hover:bg-accent/50"
        >
          <Building2 class="size-5 shrink-0 opacity-80" />
          <div class="flex-1 min-w-0">
            <div class="font-medium truncate">{{ org.name }}</div>
            <div class="mt-0.5 text-xs text-muted-foreground font-mono truncate">
              /{{ org.slug }} · {{ org.role }}
            </div>
          </div>
          <ChevronRight class="size-4 opacity-60 transition group-hover:opacity-100" />
        </NuxtLink>
      </li>
    </ul>
    <p v-else-if="!showForm" class="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      You haven't joined any organizations yet. Create one to share resources with a team.
    </p>
  </div>
</template>
