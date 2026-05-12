<script setup lang="ts">
import { X, ArrowDownToLine, ChevronUp, Circle } from "lucide-vue-next";
import { Badge } from "~/components/shadcn/badge";

interface AgentSummary {
  role: string;
  capabilities: string[];
  resources: { cpus?: string; memory?: string } | null;
  reports_to: string | null;
  delivers_to: string[];
}

interface EventRow {
  id: string;
  at: string;
  type: string;
  slug: string | null;
  role: string | null;
  task_path: string | null;
  parent_task_id: string | null;
  status: string | null;
  payload: Record<string, unknown>;
}

interface PendingDispatch {
  id: string;
  at: string;
  role: string | null;
  task_path: string | null;
  parent_task_id: string | null;
  payload: Record<string, unknown>;
}

const props = defineProps<{
  agent: AgentSummary | null;
  events: EventRow[];
  pendingDispatches: PendingDispatch[];
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

const open = computed(() => props.agent != null);

const roleEvents = computed<EventRow[]>(() => {
  if (!props.agent) return [];
  return props.events.filter((e) => e.role === props.agent!.role);
});

const currentTask = computed<PendingDispatch | null>(() => {
  if (!props.agent) return null;
  return props.pendingDispatches.find((p) => p.role === props.agent!.role) ?? null;
});

const iterationChain = computed<EventRow[]>(() => {
  if (!currentTask.value) return [];
  const chain: EventRow[] = [];
  let cursor: string | null = currentTask.value.parent_task_id;
  const byPath = new Map<string, EventRow>();
  for (const e of props.events) {
    if (e.type === "dispatch-started" && e.task_path) {
      if (!byPath.has(e.task_path)) byPath.set(e.task_path, e);
    }
  }
  while (cursor && chain.length < 20) {
    const next = [...byPath.values()].find((e) => e.task_path?.includes(cursor!));
    if (!next) break;
    chain.push(next);
    cursor = next.parent_task_id;
  }
  return chain;
});

function eventDotColor(type: string): string {
  if (type === "dispatch-started") return "text-blue-500";
  if (type === "dispatch-completed") return "text-green-500";
  if (type === "dispatch-failed") return "text-amber-500";
  if (type === "dispatch-error") return "text-red-500";
  if (type === "agent-stuck") return "text-red-600";
  return "text-muted-foreground";
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function shortPath(p: string | null): string {
  if (!p) return "";
  const parts = p.split("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && open.value) emit("close");
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <Teleport to="body">
    <Transition name="drawer">
      <div v-if="open" class="fixed inset-0 z-40 flex" @click.self="emit('close')">
        <div class="flex-1 bg-black/30" @click="emit('close')" />

        <aside class="flex h-screen w-[28rem] shrink-0 flex-col border-l border-border bg-background shadow-xl">
          <div class="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div class="min-w-0">
              <p class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{{ $t("agentDrawer.agentLabel") }}</p>
              <h2 class="truncate text-lg font-semibold">{{ agent?.role }}</h2>
            </div>
            <button
              class="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              @click="emit('close')"
              :aria-label="$t('agentDrawer.close')"
            >
              <X class="size-4" />
            </button>
          </div>

          <div class="flex-1 space-y-5 overflow-y-auto px-5 py-4 text-sm">
            <section v-if="agent">
              <p class="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{{ $t("agentDrawer.hierarchy") }}</p>
              <div class="space-y-1 text-muted-foreground">
                <p>
                  reports_to:
                  <code class="text-foreground">{{ agent.reports_to ?? "—" }}</code>
                </p>
                <p>
                  delivers_to:
                  <span v-if="agent.delivers_to.length">
                    <code v-for="(role, i) in agent.delivers_to" :key="role" class="text-foreground">
                      {{ role }}<span v-if="i < agent.delivers_to.length - 1">, </span>
                    </code>
                  </span>
                  <span v-else class="text-muted-foreground">—</span>
                </p>
              </div>
            </section>

            <section v-if="agent?.capabilities?.length">
              <p class="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{{ $t("agentDrawer.capabilities") }}</p>
              <div class="flex flex-wrap gap-1">
                <Badge v-for="cap in agent.capabilities" :key="cap" variant="outline" class="text-[11px]">
                  {{ cap }}
                </Badge>
              </div>
            </section>

            <section v-if="agent?.resources">
              <p class="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{{ $t("agentDrawer.resources") }}</p>
              <div class="space-y-1 text-muted-foreground">
                <p v-if="agent.resources.cpus">CPUs: <code class="text-foreground">{{ agent.resources.cpus }}</code></p>
                <p v-if="agent.resources.memory">Memory: <code class="text-foreground">{{ agent.resources.memory }}</code></p>
              </div>
            </section>

            <section>
              <p class="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{{ $t("agentDrawer.currentTask") }}</p>
              <div v-if="currentTask" class="rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2 text-xs">
                <div class="font-mono">{{ shortPath(currentTask.task_path) }}</div>
                <div class="mt-1 text-muted-foreground">{{ $t("agentDrawer.currentTaskSince", { time: relativeTime(currentTask.at) }) }}</div>
              </div>
              <div v-else class="text-xs text-muted-foreground">{{ $t("agentDrawer.noTask") }}</div>
            </section>

            <section v-if="iterationChain.length">
              <p class="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <ArrowDownToLine class="size-3" />
                {{ $t("agentDrawer.iterationChain") }}
              </p>
              <div class="space-y-1.5">
                <div
                  v-for="(evt, i) in iterationChain"
                  :key="evt.id"
                  class="rounded-md border bg-muted/30 px-3 py-2 text-xs"
                >
                  <div class="flex items-center gap-2">
                    <ChevronUp class="size-3 text-muted-foreground" />
                    <span class="font-mono text-muted-foreground">{{ shortPath(evt.task_path) }}</span>
                  </div>
                  <div class="mt-0.5 text-[10px] text-muted-foreground">
                    {{ evt.role }} · {{ $t('time.ago', { t: relativeTime(evt.at) }) }}
                  </div>
                </div>
              </div>
            </section>

            <section>
              <p class="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {{ $t("agentDrawer.recentEvents", { count: roleEvents.length }) }}
              </p>
              <div v-if="!roleEvents.length" class="text-xs text-muted-foreground">
                {{ $t("agentDrawer.noEvents") }}
              </div>
              <div v-else class="space-y-1 font-mono text-[11px]">
                <div
                  v-for="e in roleEvents"
                  :key="e.id"
                  class="flex items-baseline gap-2 rounded px-2 py-1 hover:bg-muted/50"
                >
                  <Circle class="size-2 shrink-0 fill-current" :class="eventDotColor(e.type)" />
                  <span class="w-12 shrink-0 text-muted-foreground">{{ relativeTime(e.at) }}</span>
                  <span class="truncate">{{ e.type }}</span>
                </div>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.drawer-enter-active,
.drawer-leave-active {
  transition: opacity 200ms ease;
}
.drawer-enter-active aside,
.drawer-leave-active aside {
  transition: transform 200ms ease;
}
.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}
.drawer-enter-from aside,
.drawer-leave-to aside {
  transform: translateX(100%);
}
</style>
