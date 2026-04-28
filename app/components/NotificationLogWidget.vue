<script setup lang="ts">
import { Activity, CheckCircle2, AlertCircle, AlertTriangle, Info, ChevronRight } from "lucide-vue-next";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import type { NotificationEvent } from "~/lib/types";

defineProps<{
  events: NotificationEvent[];
  loading?: boolean;
  previewCount?: number;
}>();

const emit = defineEmits<{
  openDrawer: [];
}>();

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

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "eben";
  if (minutes < 60) return `vor ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours}h`;
  return `vor ${Math.floor(hours / 24)}d`;
}
</script>

<template>
  <Card>
    <CardHeader>
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <Activity class="size-4 text-primary" />
          <CardTitle class="text-base">{{ $t("notifications.widgetTitle") }}</CardTitle>
        </div>
        <Button variant="ghost" size="sm" class="h-7 text-xs" @click="emit('openDrawer')">
          {{ $t("notifications.showAll") }}
          <ChevronRight class="ml-1 size-3" />
        </Button>
      </div>
    </CardHeader>
    <CardContent>
      <p v-if="loading" class="text-xs text-muted-foreground">{{ $t("common.loading") }}</p>
      <p v-else-if="!events.length" class="text-xs text-muted-foreground">
        {{ $t("notifications.noActivity") }}
      </p>
      <ul v-else class="space-y-1.5">
        <li
          v-for="ev in events.slice(0, previewCount ?? 5)"
          :key="ev.id ?? `${ev.type}-${ev.createdAt}`"
          class="flex items-start gap-2 rounded-md px-2 py-1.5 text-xs"
        >
          <component :is="icon(ev.level)" class="mt-0.5 size-3.5 shrink-0" :class="iconClass(ev.level)" />
          <div class="min-w-0 flex-1">
            <p class="truncate">
              <span class="font-medium text-foreground">{{ ev.title }}</span>
              <span v-if="ev.stepId" class="ml-1.5 text-muted-foreground">· {{ ev.stepId }}</span>
            </p>
            <p v-if="ev.message" class="mt-0.5 line-clamp-2 text-muted-foreground">{{ ev.message }}</p>
          </div>
          <span class="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
            {{ relative(ev.createdAt) }}
          </span>
        </li>
      </ul>
    </CardContent>
  </Card>
</template>
