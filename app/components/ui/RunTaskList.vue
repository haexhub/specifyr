<script setup lang="ts">
import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  Clock,
  SkipForward,
  MinusCircle,
  Lock
} from "lucide-vue-next";

export interface RunTaskRow {
  id: string;
  title: string;
  status:
    | "pending"
    | "ready"
    | "running"
    | "completed"
    | "failed"
    | "blocked_by_upstream"
    | "skipped";
  dependsOn?: string[];
  summary?: string;
  lastError?: string;
  parallelSafe?: boolean;
}

defineProps<{
  tasks: RunTaskRow[];
  activeTaskId: string | null;
}>();

defineEmits<{
  select: [taskId: string];
}>();

function statusIcon(status: string) {
  switch (status) {
    case "completed":
      return CheckCircle2;
    case "failed":
      return AlertCircle;
    case "running":
      return Loader2;
    case "blocked_by_upstream":
      return Lock;
    case "skipped":
      return SkipForward;
    default:
      return MinusCircle;
  }
}

function statusClass(status: string) {
  switch (status) {
    case "completed":
      return "text-emerald-600";
    case "failed":
      return "text-destructive";
    case "running":
      return "text-primary";
    case "blocked_by_upstream":
      return "text-amber-500";
    default:
      return "text-muted-foreground";
  }
}
</script>

<template>
  <ul class="divide-y divide-border/60">
    <li
      v-for="task in tasks"
      :key="task.id"
      class="group flex cursor-pointer items-start gap-3 px-3 py-2.5 text-sm transition hover:bg-accent/30"
      :class="activeTaskId === task.id && 'bg-accent/50'"
      @click="$emit('select', task.id)"
    >
      <component
        :is="statusIcon(task.status)"
        class="mt-0.5 size-4 shrink-0"
        :class="[statusClass(task.status), task.status === 'running' && 'animate-spin']"
      />
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline gap-2">
          <code class="font-mono text-xs text-muted-foreground">{{ task.id }}</code>
          <span class="truncate font-medium">{{ task.title }}</span>
        </div>
        <p v-if="task.summary" class="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
          {{ task.summary }}
        </p>
        <p v-else-if="task.lastError" class="mt-0.5 line-clamp-2 text-xs text-destructive">
          {{ task.lastError }}
        </p>
        <div
          v-if="task.dependsOn?.length"
          class="mt-0.5 flex flex-wrap gap-1 text-[10px] text-muted-foreground"
        >
          <span>{{ $t("runTask.dependsOn") }}</span>
          <code
            v-for="d in task.dependsOn"
            :key="d"
            class="rounded bg-muted px-1 py-0.5 font-mono"
          >
            {{ d }}
          </code>
        </div>
      </div>
      <Clock
        v-if="task.status === 'pending' || task.status === 'ready'"
        class="mt-0.5 size-4 shrink-0 text-muted-foreground/50"
      />
    </li>
  </ul>
</template>
