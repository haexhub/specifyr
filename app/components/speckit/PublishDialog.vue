<script setup lang="ts">
import { computed } from "vue";
import { AlertTriangle, X } from "lucide-vue-next";
import { Button } from "~/components/shadcn/button";

type ConflictFile = { name: string; content: string };

const props = defineProps<{
  open: boolean;
  conflict: {
    currentPublicVersion: number;
    currentPublicFiles: ConflictFile[];
  } | null;
  draftFiles: Record<string, string>;
  draftBaseVersion: number;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  retry: [];
  copyPublic: [];
}>();

const filesByName = computed(() => {
  const map = new Map<string, { mine?: string; theirs?: string }>();
  for (const [name, mine] of Object.entries(props.draftFiles)) {
    map.set(name, { ...(map.get(name) ?? {}), mine });
  }
  for (const f of props.conflict?.currentPublicFiles ?? []) {
    map.set(f.name, { ...(map.get(f.name) ?? {}), theirs: f.content });
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
});

function close() {
  emit("update:open", false);
}
</script>

<template>
  <div
    v-if="open && conflict"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    role="dialog"
    aria-modal="true"
  >
    <div class="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-lg border border-border bg-background shadow-xl">
      <header class="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div class="space-y-1">
          <p class="flex items-center gap-2 text-base font-semibold">
            <AlertTriangle class="size-4 text-amber-500" />
            Publish conflict
          </p>
          <p class="text-sm text-muted-foreground">
            Your draft is based on v{{ draftBaseVersion }}, but the project is now at
            <span class="font-medium text-foreground">v{{ conflict.currentPublicVersion }}</span>.
            Reconcile your changes against the new public state before publishing again.
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon" @click="close">
          <X class="size-4" />
        </Button>
      </header>

      <div class="flex-1 overflow-auto px-5 py-3">
        <div
          v-for="[name, pair] in filesByName"
          :key="name"
          class="mb-4 rounded-md border border-border"
        >
          <p class="border-b border-border bg-muted/30 px-3 py-1.5 text-xs font-mono">{{ name }}</p>
          <div class="grid gap-px bg-border/60 md:grid-cols-2">
            <div class="bg-background p-3">
              <p class="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Your draft</p>
              <pre v-if="pair.mine !== undefined" class="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{{ pair.mine }}</pre>
              <p v-else class="text-xs italic text-muted-foreground">(not in your draft)</p>
            </div>
            <div class="bg-background p-3">
              <p class="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">New public (v{{ conflict.currentPublicVersion }})</p>
              <pre v-if="pair.theirs !== undefined" class="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{{ pair.theirs }}</pre>
              <p v-else class="text-xs italic text-muted-foreground">(deleted upstream)</p>
            </div>
          </div>
        </div>
      </div>

      <footer class="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
        <Button type="button" variant="ghost" @click="close">Cancel</Button>
        <Button type="button" variant="outline" @click="emit('copyPublic')">
          Pull public into draft
        </Button>
        <Button type="button" @click="emit('retry')">Retry publish</Button>
      </footer>
    </div>
  </div>
</template>
