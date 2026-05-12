<script setup lang="ts">
import { KeyRound, Trash2, Plus, Eye, EyeOff } from "lucide-vue-next";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/shadcn/card";
import { Button } from "~/components/shadcn/button";
import { Input } from "~/components/shadcn/input";
import { Badge } from "~/components/shadcn/badge";
import ProjectShell from "~/components/projects/ProjectShell.vue";

const route = useRoute();
const slug = computed(() => route.params.slug as string);

const { data, refresh } = await useFetch<{ keys: string[] }>(
  () => `/api/projects/${slug.value}/secrets`,
);
const keys = computed(() => data.value?.keys ?? []);

const newKey = ref("");
const newValue = ref("");
const showValue = ref(false);
const adding = ref(false);
const error = ref<string | null>(null);

async function removeSecret(key: string) {
  try {
    await $fetch(`/api/projects/${slug.value}/secrets/${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
    await refresh();
  } catch (e: any) {
    error.value = e?.data?.statusMessage ?? "Failed to delete secret.";
  }
}

// TODO: Implement addSecret() here.
//
// This function is called when the user submits the "Add secret" form.
// It should:
//   1. POST { key: newKey.value, value: newValue.value } to /api/projects/<slug>/secrets
//   2. Reset newKey, newValue, error on success
//   3. Call refresh() so the key list updates
//   4. Set error.value on failure (show the message to the user)
//   5. Guard against empty key/value (set error and return early)
//
// Use `adding` as a loading flag so the button shows a disabled state while the
// request is in-flight (set true before fetch, false in finally).
//
// Trade-offs to consider:
//   - Should submitting with Enter in the value field also trigger this?
//   - Should the value field be cleared after success even if you might add more secrets?
async function addSecret() {
  error.value = null;
  if (!newKey.value.trim() || !newValue.value) {
    error.value = "Key and value are required.";
    return;
  }
  adding.value = true;
  try {
    await $fetch(`/api/projects/${slug.value}/secrets`, {
      method: "POST",
      body: { key: newKey.value.trim(), value: newValue.value },
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
  <ProjectsProjectShell :slug="slug">
    <div class="p-6 max-w-2xl space-y-6">
      <div>
        <h2 class="text-lg font-semibold flex items-center gap-2">
          <KeyRound class="size-4" />
          Project Secrets
        </h2>
        <p class="text-sm text-muted-foreground mt-1">
          Secrets are encrypted at rest and injected as environment variables into agent
          containers at runtime. Values are never shown after saving.
        </p>
      </div>

      <!-- Existing secrets list -->
      <Card>
        <CardHeader class="pb-3">
          <CardTitle class="text-sm font-medium">Stored secrets</CardTitle>
          <CardDescription v-if="keys.length === 0">No secrets configured yet.</CardDescription>
        </CardHeader>
        <CardContent class="space-y-2">
          <div
            v-for="key in keys"
            :key="key"
            class="flex items-center justify-between rounded-md border px-3 py-2"
          >
            <div class="flex items-center gap-2">
              <Badge variant="secondary" class="font-mono text-xs">{{ key }}</Badge>
              <span class="text-xs text-muted-foreground">••••••••</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              class="size-7 text-muted-foreground hover:text-destructive"
              @click="removeSecret(key)"
            >
              <Trash2 class="size-3.5" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <!-- Add new secret -->
      <Card>
        <CardHeader class="pb-3">
          <CardTitle class="text-sm font-medium">Add secret</CardTitle>
        </CardHeader>
        <CardContent class="space-y-3">
          <div class="flex gap-2">
            <Input
              v-model="newKey"
              placeholder="KEY_NAME"
              class="font-mono text-sm uppercase"
              @input="newKey = (newKey as string).toUpperCase().replace(/[^A-Z0-9_]/g, '')"
            />
            <div class="relative flex-1">
              <Input
                v-model="newValue"
                :type="showValue ? 'text' : 'password'"
                placeholder="value"
                class="pr-9"
                @keydown.enter="addSecret"
              />
              <button
                type="button"
                class="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                @click="showValue = !showValue"
              >
                <Eye v-if="!showValue" class="size-3.5" />
                <EyeOff v-else class="size-3.5" />
              </button>
            </div>
            <Button :disabled="adding" @click="addSecret">
              <Plus class="size-4" />
              Add
            </Button>
          </div>
          <p v-if="error" class="text-xs text-destructive">{{ error }}</p>
        </CardContent>
      </Card>
    </div>
  </ProjectsProjectShell>
</template>
