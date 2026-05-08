<script setup lang="ts">
import { CheckCircle2, XCircle, Loader, Clock } from "lucide-vue-next";

interface TaskSummary {
  path: string;
  title: string | null;
}

interface AgentRow {
  role: string;
  activeTask: TaskSummary | null;
  queuedTasks: TaskSummary[];
}

interface EventRow {
  id: string;
  at: string;
  type: string;
  role: string | null;
  task_path: string | null;
  payload: Record<string, unknown>;
}

const props = defineProps<{
  agents: AgentRow[];
  events: EventRow[];
}>();

function completedForRole(role: string): EventRow[] {
  return props.events
    .filter(
      (e) =>
        e.role === role &&
        (e.type === "dispatch-completed" ||
          e.type === "dispatch-failed" ||
          e.type === "dispatch-error"),
    )
    .slice(0, 3);
}

function taskLabel(e: EventRow): string {
  const t = e.payload?.task_title as string | undefined;
  if (t) return t;
  if (!e.task_path) return e.type;
  const parts = e.task_path.split("/");
  return (parts[parts.length - 1] ?? "").replace(/\.ya?ml$/, "");
}

function queuedLabel(t: TaskSummary): string {
  if (t.title) return t.title;
  const parts = t.path.split("/");
  return (parts[parts.length - 1] ?? "").replace(/\.ya?ml$/, "");
}
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-border">
          <th class="py-2 pr-4 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {{ $t("taskBoard.colAgent") }}
          </th>
          <th class="py-2 pr-4 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <Clock class="mb-0.5 mr-1 inline size-3" />
            {{ $t("taskBoard.colPlanned") }}
          </th>
          <th class="py-2 pr-4 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <Loader class="mb-0.5 mr-1 inline size-3 animate-spin" />
            {{ $t("taskBoard.colActive") }}
          </th>
          <th class="py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <CheckCircle2 class="mb-0.5 mr-1 inline size-3" />
            {{ $t("taskBoard.colDone") }}
          </th>
        </tr>
      </thead>
      <tbody class="divide-y divide-border">
        <tr v-for="agent in agents" :key="agent.role" class="align-top">
          <td class="py-2.5 pr-4">
            <span class="font-medium">{{ agent.role }}</span>
          </td>

          <!-- Planned -->
          <td class="py-2.5 pr-4">
            <div v-if="agent.queuedTasks.length === 0" class="text-xs text-muted-foreground">—</div>
            <div v-else class="space-y-1">
              <div
                v-for="t in agent.queuedTasks"
                :key="t.path"
                class="truncate rounded bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
                :title="t.path"
              >
                {{ queuedLabel(t) }}
              </div>
            </div>
          </td>

          <!-- Active -->
          <td class="py-2.5 pr-4">
            <div v-if="!agent.activeTask" class="text-xs text-muted-foreground">—</div>
            <div
              v-else
              class="truncate rounded border border-blue-500/30 bg-blue-500/10 px-2 py-1 text-xs font-medium text-blue-700 dark:text-blue-300"
              :title="agent.activeTask.path"
            >
              {{ agent.activeTask.title ?? queuedLabel(agent.activeTask) }}
            </div>
          </td>

          <!-- Done (derived from events) -->
          <td class="py-2.5">
            <div v-if="completedForRole(agent.role).length === 0" class="text-xs text-muted-foreground">—</div>
            <div v-else class="space-y-1">
              <div
                v-for="e in completedForRole(agent.role)"
                :key="e.id"
                class="flex items-center gap-1.5 truncate rounded px-2 py-1 text-xs"
                :class="
                  e.type === 'dispatch-completed'
                    ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                    : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                "
                :title="e.task_path ?? ''"
              >
                <CheckCircle2 v-if="e.type === 'dispatch-completed'" class="size-3 shrink-0" />
                <XCircle v-else class="size-3 shrink-0" />
                {{ taskLabel(e) }}
              </div>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
