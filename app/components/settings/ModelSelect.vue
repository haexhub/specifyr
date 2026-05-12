<script setup lang="ts">
import { Check, ChevronsUpDown } from "lucide-vue-next";
import { cn } from "~/utils/utils";

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
const open = ref(false);
let fetchToken = 0;

async function load(credentialId: string) {
  models.value = [];
  error.value = null;
  const token = ++fetchToken;
  if (!credentialId) {
    loading.value = false;
    if (props.modelValue) emit("update:modelValue", "");
    return;
  }
  loading.value = true;
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

watch(
  () => props.credentialId,
  (id) => {
    void load(id);
  },
);

onMounted(() => {
  void load(props.credentialId);
});

const selectedLabel = computed(() => {
  const m = models.value.find((x) => x.id === props.modelValue);
  return m?.label ?? "";
});

const triggerLabel = computed(() => {
  if (!props.credentialId) return "Select a credential first";
  if (loading.value) return "Loading models…";
  if (error.value) return "—";
  if (selectedLabel.value) return selectedLabel.value;
  if (models.value.length === 0) return "No models returned";
  return "Select a model";
});

const isDisabled = computed(
  () => props.disabled || loading.value || !props.credentialId || !!error.value,
);

function select(id: string) {
  emit("update:modelValue", id);
  open.value = false;
}
</script>

<template>
  <div class="block">
    <span class="text-xs font-medium">Model</span>
    <Popover v-model:open="open">
      <PopoverTrigger as-child>
        <button
          type="button"
          role="combobox"
          :aria-expanded="open"
          :disabled="isDisabled"
          :class="
            cn(
              'mt-1 flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50',
              !selectedLabel && 'text-muted-foreground',
            )
          "
        >
          <span class="truncate text-left">{{ triggerLabel }}</span>
          <ChevronsUpDown class="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent class="w-[--reka-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search models…" />
          <CommandList>
            <CommandEmpty>No model found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                v-for="m in models"
                :key="m.id"
                :value="`${m.label} ${m.id}`"
                @select="select(m.id)"
              >
                <Check
                  :class="
                    cn(
                      'mr-2 h-4 w-4',
                      modelValue === m.id ? 'opacity-100' : 'opacity-0',
                    )
                  "
                />
                <span class="truncate">{{ m.label }}</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
    <p v-if="error" class="mt-1 text-xs text-destructive">{{ error }}</p>
  </div>
</template>
