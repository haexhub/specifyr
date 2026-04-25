<script setup lang="ts">
import { Info, ChevronDown, ChevronRight } from "lucide-vue-next";
import type { StepDefinition } from "~/lib/steps";

defineProps<{
  step: StepDefinition;
}>();

const expanded = ref(true);
</script>

<template>
  <div class="border-b border-border/60 bg-muted/20">
    <button
      type="button"
      class="flex w-full items-start gap-2 px-6 py-2.5 text-left text-xs text-muted-foreground transition hover:bg-muted/40"
      @click="expanded = !expanded"
    >
      <Info class="mt-0.5 size-3.5 shrink-0 text-primary" />
      <span class="flex-1">
        <span class="font-medium text-foreground">{{ step.label }}</span>
        <span v-if="!expanded" class="ml-2 italic">{{ step.summary }}</span>
      </span>
      <ChevronDown v-if="expanded" class="mt-0.5 size-3.5 shrink-0" />
      <ChevronRight v-else class="mt-0.5 size-3.5 shrink-0" />
    </button>

    <div v-if="expanded" class="space-y-3 border-t border-border/40 px-6 py-3 text-xs text-muted-foreground">
      <p class="leading-6">{{ step.description }}</p>
      <ul v-if="step.tips.length" class="space-y-1">
        <li v-for="tip in step.tips" :key="tip" class="flex items-start gap-1.5">
          <span class="mt-1 block size-1 shrink-0 rounded-full bg-muted-foreground/50" />
          <span class="leading-5">{{ tip }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
