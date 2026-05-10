<script setup lang="ts">
type ModelChoice = { id: string; label: string };

const props = defineProps<{
  modelValue: string;
  // Base path of the credentials API (e.g. "/api/me/llm-credentials").
  // Combined with credentialId to build "<base>/<id>/models".
  credentialsEndpoint: string;
  credentialId: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const models = ref<ModelChoice[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
let fetchToken = 0;

async function load(credentialId: string) {
  models.value = [];
  error.value = null;
  if (!credentialId) {
    loading.value = false;
    return;
  }
  loading.value = true;
  const token = ++fetchToken;
  try {
    const res = await $fetch<{ models: ModelChoice[] }>(
      `${props.credentialsEndpoint}/${credentialId}/models`,
    );
    if (token !== fetchToken) return;
    models.value = res.models;
    // If the saved model isn't in the list, drop it so the user sees
    // the empty placeholder rather than a stale value silently kept.
    if (props.modelValue && !res.models.some((m) => m.id === props.modelValue)) {
      emit("update:modelValue", "");
    } else if (!props.modelValue && res.models.length === 1) {
      emit("update:modelValue", res.models[0]!.id);
    }
  } catch (err: unknown) {
    if (token !== fetchToken) return;
    const e = err as { data?: { statusMessage?: string }; statusMessage?: string };
    error.value =
      e?.data?.statusMessage ??
      e?.statusMessage ??
      (err instanceof Error ? err.message : "could not load models");
  } finally {
    if (token === fetchToken) loading.value = false;
  }
}

// Initial load runs on mount (client-only) to avoid hydration
// mismatches caused by load() racing the SSR/CSR boundary.
watch(
  () => props.credentialId,
  (id) => {
    void load(id);
  },
);

onMounted(() => {
  void load(props.credentialId);
});

function onChange(event: Event) {
  emit("update:modelValue", (event.target as HTMLSelectElement).value);
}
</script>

<template>
  <label class="block">
    <span class="text-xs font-medium">Model</span>
    <select
      :value="modelValue"
      class="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
      :disabled="disabled || loading || !credentialId || !!error"
      @change="onChange"
    >
      <option value="">
        <template v-if="!credentialId">Select a credential first</template>
        <template v-else-if="loading">Loading models…</template>
        <template v-else-if="error">—</template>
        <template v-else-if="models.length === 0">No models returned</template>
        <template v-else>Select a model</template>
      </option>
      <option v-for="m in models" :key="m.id" :value="m.id">{{ m.label }}</option>
    </select>
    <p v-if="error" class="mt-1 text-xs text-destructive">{{ error }}</p>
  </label>
</template>
