<script setup lang="ts">
import { Loader2, CheckCircle2, AlertCircle, Wrench, RotateCcw, SkipForward } from "lucide-vue-next";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import type { RunTaskRow } from "~/components/RunTaskList.vue";

export interface TaskLogEntry {
  ts: string | null;
  kind: "start" | "chunk" | "tool_use" | "complete" | "failed";
  title?: string;
  description?: string;
  text?: string;
  name?: string;
  summary?: string;
  error?: string;
}

const props = defineProps<{
  task: RunTaskRow | null;
  log: TaskLogEntry[];
  liveText: string;
  streaming: boolean;
  runActive: boolean;
  busy?: boolean;
}>();

const emit = defineEmits<{
  retry: [taskId: string];
  skip: [taskId: string];
}>();

function statusBadgeVariant(status?: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "failed" || status === "blocked_by_upstream") return "destructive";
  return "secondary";
}

const canRetry = computed(() => {
  if (!props.task || props.runActive) return false;
  return (
    props.task.status === "failed" ||
    props.task.status === "skipped" ||
    props.task.status === "blocked_by_upstream" ||
    props.task.status === "completed"
  );
});

const canSkip = computed(() => {
  if (!props.task || props.runActive) return false;
  return (
    props.task.status === "pending" ||
    props.task.status === "ready" ||
    props.task.status === "failed" ||
    props.task.status === "blocked_by_upstream"
  );
});
</script>

<template>
  <div v-if="!task" class="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
    Wähle einen Task aus der Liste.
  </div>
  <div v-else class="flex h-full flex-col">
    <header class="border-b border-border/60 px-5 py-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <code class="font-mono text-sm text-muted-foreground">{{ task.id }}</code>
            <Badge :variant="statusBadgeVariant(task.status)">{{ task.status }}</Badge>
          </div>
          <h2 class="mt-1 text-base font-semibold">{{ task.title }}</h2>
          <div v-if="task.dependsOn?.length" class="mt-1 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
            <span>dependsOn:</span>
            <code v-for="d in task.dependsOn" :key="d" class="rounded bg-muted px-1 py-0.5">{{ d }}</code>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          <Button
            v-if="canRetry"
            variant="outline"
            size="sm"
            :disabled="busy"
            :title="task.status === 'completed' ? 'Task neu ausführen' : 'Task für nächsten Run zurücksetzen'"
            @click="emit('retry', task.id)"
          >
            <RotateCcw class="mr-1.5 size-3.5" />
            Retry
          </Button>
          <Button
            v-if="canSkip"
            variant="ghost"
            size="sm"
            :disabled="busy"
            class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title="Task als übersprungen markieren"
            @click="emit('skip', task.id)"
          >
            <SkipForward class="mr-1.5 size-3.5" />
            Skip
          </Button>
        </div>
      </div>
    </header>

    <div class="flex-1 overflow-y-auto p-5 text-xs">
      <p v-if="!log.length && !liveText" class="italic text-muted-foreground">
        Noch keine Ausgabe. Bei laufendem Run erscheinen Tokens live hier.
      </p>

      <div class="space-y-3">
        <div v-for="(entry, i) in log" :key="i" class="space-y-1">
          <div v-if="entry.kind === 'start'" class="rounded-md border border-border/60 bg-muted/30 p-3">
            <p class="text-xs font-medium">Task gestartet</p>
            <p v-if="entry.description" class="mt-1 whitespace-pre-wrap text-muted-foreground">{{ entry.description }}</p>
          </div>
          <pre v-else-if="entry.kind === 'chunk'" class="whitespace-pre-wrap wrap-break-word font-mono leading-5">{{ entry.text }}</pre>
          <div v-else-if="entry.kind === 'tool_use'" class="inline-flex items-center gap-1.5 rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            <Wrench class="size-3" />
            <code>{{ entry.name }}</code>
          </div>
          <div v-else-if="entry.kind === 'complete'" class="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-emerald-900 dark:text-emerald-200">
            <CheckCircle2 class="mt-0.5 size-4 shrink-0" />
            <div>
              <p class="font-medium">Task abgeschlossen</p>
              <p v-if="entry.summary" class="mt-1 text-[11px] opacity-80">{{ entry.summary }}</p>
            </div>
          </div>
          <div v-else-if="entry.kind === 'failed'" class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-destructive">
            <AlertCircle class="mt-0.5 size-4 shrink-0" />
            <div>
              <p class="font-medium">Task fehlgeschlagen</p>
              <p v-if="entry.error" class="mt-1 text-[11px]">{{ entry.error }}</p>
            </div>
          </div>
        </div>

        <pre v-if="liveText" class="whitespace-pre-wrap wrap-break-word font-mono leading-5">{{ liveText }}<span v-if="streaming" class="ml-1 inline-block h-3 w-1 animate-pulse bg-current align-middle" /></pre>

        <p v-if="streaming" class="flex items-center gap-2 text-muted-foreground">
          <Loader2 class="size-3 animate-spin" />
          <span>läuft…</span>
        </p>
      </div>
    </div>
  </div>
</template>
