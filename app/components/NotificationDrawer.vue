<script setup lang="ts">
import { X, CheckCircle2, AlertCircle, AlertTriangle, Info } from "lucide-vue-next";
import { Button } from "~/components/shadcn/button";
import type { NotificationEvent } from "~/lib/types";

const props = defineProps<{
  open: boolean;
  events: NotificationEvent[];
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
}>();

const levelFilter = ref<"all" | "info" | "success" | "warning" | "error">("all");

const filtered = computed(() => {
  if (levelFilter.value === "all") return props.events;
  return props.events.filter((e) => e.level === levelFilter.value);
});

function icon(level: string) {
  if (level === "success") return CheckCircle2;
  if (level === "error") return AlertCircle;
  if (level === "warning") return AlertTriangle;
  return Info;
}
function iconClass(level: string) {
  if (level === "success") return "text-emerald-600";
  if (level === "error") return "text-destructive";
  if (level === "warning") return "text-amber-500";
  return "text-muted-foreground";
}
function localTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function close() {
  emit("update:open", false);
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-stretch justify-end bg-black/40 backdrop-blur-sm"
      @click.self="close"
    >
      <aside class="flex h-full w-full max-w-xl flex-col bg-background shadow-2xl">
        <header class="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 class="text-base font-semibold">{{ $t("notifications.title") }}</h2>
            <p class="text-xs text-muted-foreground">{{ $t("notifications.entries", { count: filtered.length }) }}</p>
          </div>
          <button
            type="button"
            class="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
            @click="close"
          >
            <X class="size-4" />
          </button>
        </header>

        <div class="flex flex-wrap gap-1.5 border-b border-border/60 px-5 py-2.5">
          <Button
            v-for="lvl in (['all', 'info', 'success', 'warning', 'error'] as const)"
            :key="lvl"
            :variant="levelFilter === lvl ? 'default' : 'ghost'"
            size="sm"
            class="h-7 text-xs capitalize"
            @click="levelFilter = lvl"
          >
            {{ $t('notifications.filters.' + lvl) }}
          </Button>
        </div>

        <div class="flex-1 overflow-y-auto px-5 py-3">
          <p v-if="!filtered.length" class="py-8 text-center text-sm text-muted-foreground">
            {{ $t("notifications.noEntries") }}
          </p>
          <ul v-else class="space-y-2">
            <li
              v-for="ev in filtered"
              :key="ev.id ?? `${ev.type}-${ev.createdAt}`"
              class="rounded-md border border-border/60 bg-muted/10 p-3"
            >
              <div class="flex items-start gap-2">
                <component :is="icon(ev.level)" class="mt-0.5 size-4 shrink-0" :class="iconClass(ev.level)" />
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-baseline gap-2">
                    <p class="text-sm font-medium">{{ ev.title }}</p>
                    <code class="text-[10px] text-muted-foreground">{{ ev.type }}</code>
                  </div>
                  <p v-if="ev.message" class="mt-1 text-xs text-muted-foreground">{{ ev.message }}</p>
                  <div class="mt-1 flex flex-wrap gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <span v-if="ev.stepId">step · {{ ev.stepId }}</span>
                    <span v-if="ev.sessionId">session · {{ ev.sessionId.slice(0, 8) }}</span>
                    <span>{{ localTime(ev.createdAt) }}</span>
                  </div>
                </div>
              </div>
            </li>
          </ul>
        </div>
      </aside>
    </div>
  </Teleport>
</template>
