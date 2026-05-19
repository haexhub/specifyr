<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { Eye, EyeOff, Save, X } from "lucide-vue-next";
import { Button } from "~/components/shadcn/button";
import { Input } from "~/components/shadcn/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/shadcn/select";
import type { ProviderIdentity, ProviderName } from "~/stores/provider-identity";

type FormValue = Omit<ProviderIdentity, "id">;

const props = defineProps<{
  /** Existing identity if editing, undefined when adding a new one. */
  initial?: ProviderIdentity;
}>();

const emit = defineEmits<{
  save: [value: FormValue];
  cancel: [];
}>();

const PROVIDERS: { value: ProviderName; label: string }[] = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "google", label: "Google" },
  { value: "openrouter", label: "OpenRouter" },
];

const form = reactive({
  label: "",
  provider: "anthropic" as ProviderName,
  model: "",
  apiKey: "",
  baseUrl: "",
});

const showKey = ref(false);
const error = ref<string | null>(null);

watch(
  () => props.initial,
  (v) => {
    form.label = v?.label ?? "";
    form.provider = v?.provider ?? "anthropic";
    form.model = v?.model ?? "";
    form.apiKey = v?.apiKey ?? "";
    form.baseUrl = v?.baseUrl ?? "";
    showKey.value = false;
    error.value = null;
  },
  { immediate: true },
);

const canSave = computed(
  () => form.label.trim() && form.model.trim() && form.apiKey.trim(),
);

function submit() {
  if (!canSave.value) {
    error.value = "Label, model and API key are required.";
    return;
  }
  emit("save", {
    label: form.label.trim(),
    provider: form.provider,
    model: form.model.trim(),
    apiKey: form.apiKey.trim(),
    baseUrl: form.baseUrl.trim() || undefined,
  });
}
</script>

<template>
  <form
    class="space-y-3 rounded-lg border border-border bg-card p-4"
    @submit.prevent="submit"
  >
    <div class="grid gap-3 sm:grid-cols-2">
      <label class="space-y-1 text-sm">
        <span class="font-medium">Label</span>
        <Input v-model="form.label" placeholder="My Anthropic key" required />
      </label>

      <label class="space-y-1 text-sm">
        <span class="font-medium">Provider</span>
        <Select v-model="form.provider">
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="p in PROVIDERS" :key="p.value" :value="p.value">
              {{ p.label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </label>

      <label class="space-y-1 text-sm sm:col-span-2">
        <span class="font-medium">Model</span>
        <Input
          v-model="form.model"
          placeholder="claude-opus-4-7 / gpt-4o / gemini-2.5-pro / …"
          required
        />
        <span class="text-xs text-muted-foreground">
          Free text — whatever ID the provider accepts. We don't validate.
        </span>
      </label>

      <label class="space-y-1 text-sm sm:col-span-2">
        <span class="font-medium">API key</span>
        <div class="flex items-center gap-2">
          <Input
            v-model="form.apiKey"
            :type="showKey ? 'text' : 'password'"
            autocomplete="off"
            spellcheck="false"
            placeholder="sk-…"
            required
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            :aria-label="showKey ? 'Hide key' : 'Show key'"
            @click="showKey = !showKey"
          >
            <component :is="showKey ? EyeOff : Eye" class="size-4" />
          </Button>
        </div>
        <span class="text-xs text-muted-foreground">
          Stays in this browser (localStorage). Never sent to the Specifyr server.
        </span>
      </label>

      <label class="space-y-1 text-sm sm:col-span-2">
        <span class="font-medium">Base URL <span class="text-muted-foreground">(optional)</span></span>
        <Input
          v-model="form.baseUrl"
          placeholder="https://api.openai.com/v1"
          inputmode="url"
        />
      </label>
    </div>

    <p v-if="error" class="text-sm text-destructive">{{ error }}</p>

    <div class="flex items-center justify-end gap-2 pt-1">
      <Button type="button" variant="ghost" @click="emit('cancel')">
        <X class="size-4" /> Cancel
      </Button>
      <Button type="submit" :disabled="!canSave">
        <Save class="size-4" /> Save
      </Button>
    </div>
  </form>
</template>
