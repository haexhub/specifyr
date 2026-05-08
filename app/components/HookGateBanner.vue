<script setup lang="ts">
import { ShieldCheck, ExternalLink } from "lucide-vue-next";
import { Button } from "~/components/shadcn/button";
import type { HookGate } from "~/lib/hooks";

defineProps<{
  gates: HookGate[];
}>();

const emit = defineEmits<{
  useCommand: [command: string];
}>();
</script>

<template>
  <div v-if="gates.length" class="space-y-2 border-b border-amber-500/30 bg-amber-500/5 px-6 py-3">
    <div
      v-for="gate in gates"
      :key="`${gate.extensionSlug}:${gate.requiredCommand}`"
      class="space-y-1"
    >
      <div class="flex items-start gap-2">
        <ShieldCheck class="mt-0.5 size-4 shrink-0 text-amber-600" />
        <div class="flex-1 text-xs">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium text-foreground">{{ gate.label }}</span>
            <code class="rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[11px] text-amber-900 dark:text-amber-200">
              {{ gate.extensionSlug }}
            </code>
          </div>
          <p class="mt-1 text-muted-foreground">{{ gate.description }}</p>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" class="h-7 text-xs" @click="emit('useCommand', gate.requiredCommand)">
              <code class="font-mono">{{ gate.requiredCommand }}</code> {{ $t("hookGate.insert") }}
            </Button>
            <a
              :href="gate.docsUrl"
              target="_blank"
              rel="noopener"
              class="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {{ $t("hookGate.docs") }}
              <ExternalLink class="size-3" />
            </a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
