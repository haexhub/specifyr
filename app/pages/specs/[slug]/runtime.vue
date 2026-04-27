<script setup lang="ts">
// Runtime-View — Inkrement 13.
//
// Layout matches Speckit-View: left sidebar (project context) + content area
// with view-tab navigation. Three logically distinct panes in the body:
//   1. Org Chart  — static from spec (reports_to + delivers_to)
//   2. Live Status — polled from /company/status (current dispatch state)
//   3. History    — polled from /company/events (JSONL → SQLite-indexed log)
//
// Polling is fine for v1; intervals are conservative because the underlying
// source-of-truth is files-on-disk + SQLite, neither hammered well.

import { Activity, Network, History, Circle } from "lucide-vue-next";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import ProjectShell from "~/components/ProjectShell.vue";
import { resolveWorkflow, type Workflow } from "~/lib/workflows";

const route = useRoute();
const slug = computed(() => route.params.slug as string);

interface AgentStatus {
  role: string;
  capabilities: string[];
  resources: { cpus?: string; memory?: string } | null;
  reports_to: string | null;
  delivers_to: string[];
}

interface CompanyStatus {
  slug: string;
  status: "running" | "idle" | "stopped";
  agents?: AgentStatus[];
  queueDepth?: number;
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

// Project snapshot — same fetch the Speckit page uses, so the sidebar can
// show the project title.
const { data: project } = await useFetch<{
  workflow?: string;
  workflowDefinition?: Workflow;
  title?: string;
  [k: string]: unknown;
}>(() => `/api/projects/${slug.value}`, {
  key: () => `project-${slug.value}`,
});

const workflow = computed(() =>
  resolveWorkflow(project.value?.workflow, project.value?.workflowDefinition ?? null),
);

// Live status — refresh every 3s while running.
const { data: companyStatus, refresh: refreshStatus } = await useFetch<CompanyStatus>(
  () => `/api/projects/${slug.value}/company/status`,
  {
    default: () => ({ slug: slug.value, status: "idle" } as CompanyStatus),
    key: () => `cstatus-${slug.value}`,
  },
);

const isRunning = computed(() => companyStatus.value?.status === "running");

// Events — polled while running.
const events = ref<EventRow[]>([]);
const eventsError = ref<string | null>(null);

async function fetchEvents() {
  if (!isRunning.value) {
    events.value = [];
    return;
  }
  try {
    const data = await $fetch<{ events: EventRow[] }>(
      `/api/projects/${slug.value}/company/events?limit=50`,
    );
    events.value = data.events;
    eventsError.value = null;
  } catch (err: unknown) {
    eventsError.value = err instanceof Error ? err.message : String(err);
  }
}

let statusTimer: ReturnType<typeof setInterval> | null = null;
let eventsTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  fetchEvents();
  statusTimer = setInterval(refreshStatus, 3_000);
  eventsTimer = setInterval(fetchEvents, 5_000);
});

onBeforeUnmount(() => {
  if (statusTimer) clearInterval(statusTimer);
  if (eventsTimer) clearInterval(eventsTimer);
});

// Pending dispatches — derived from event log: dispatch-started without a
// matching terminal event (completed/failed/error) on the same task_path.
const pendingDispatches = computed(() => {
  const started = new Map<string, EventRow>();
  for (const evt of [...events.value].reverse()) {
    if (!evt.task_path) continue;
    if (evt.type === "dispatch-started") started.set(evt.task_path, evt);
    if (
      evt.type === "dispatch-completed" ||
      evt.type === "dispatch-failed" ||
      evt.type === "dispatch-error"
    ) {
      started.delete(evt.task_path);
    }
  }
  return [...started.values()];
});

const orgRoots = computed<AgentStatus[]>(() => {
  const agents = companyStatus.value?.agents ?? [];
  return agents.filter((a) => a.reports_to == null);
});

function childrenOf(parentRole: string): AgentStatus[] {
  const agents = companyStatus.value?.agents ?? [];
  return agents.filter((a) => a.reports_to === parentRole);
}

function eventDotColor(type: string): string {
  if (type === "dispatch-started") return "text-blue-500";
  if (type === "dispatch-completed") return "text-green-500";
  if (type === "dispatch-failed") return "text-amber-500";
  if (type === "dispatch-error") return "text-red-500";
  if (type === "agent-stuck") return "text-red-600";
  return "text-muted-foreground";
}

function shortPath(p: string | null): string {
  if (!p) return "";
  const parts = p.split("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
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
</script>

<template>
  <ProjectShell
    :slug="slug"
    :project-title="project?.title"
    :workflow="workflow"
    :show-steps="false"
  >
    <template #sidebar>
      <div class="space-y-3 px-3 py-3 text-xs text-muted-foreground">
        <p class="font-medium text-foreground">Runtime</p>
        <div class="flex items-center gap-2">
          <Circle
            class="size-2 fill-current"
            :class="isRunning ? 'text-green-500' : 'text-muted-foreground'"
          />
          <span class="font-medium text-foreground">{{ companyStatus?.status ?? "idle" }}</span>
        </div>
        <div v-if="isRunning" class="space-y-1">
          <p>
            Agents: <span class="font-medium text-foreground">{{ companyStatus?.agents?.length ?? 0 }}</span>
          </p>
          <p>
            Queue-Tiefe: <span class="font-medium text-foreground">{{ companyStatus?.queueDepth ?? 0 }}</span>
          </p>
          <p>
            Pending: <span class="font-medium text-foreground">{{ pendingDispatches.length }}</span>
          </p>
        </div>
      </div>
    </template>

    <header class="flex flex-wrap items-center justify-end gap-3">
      <Badge :variant="isRunning ? 'default' : 'secondary'">
        <Circle
          class="mr-1 size-2 fill-current"
          :class="isRunning ? 'text-green-500' : 'text-muted-foreground'"
        />
        {{ companyStatus?.status ?? "idle" }}
      </Badge>
    </header>

        <!-- Idle state -->
        <Card v-if="!isRunning">
          <CardContent class="py-10 text-center text-sm text-muted-foreground">
            Die Company läuft gerade nicht. Starte sie über den
            <NuxtLink :to="`/specs/${slug}`" class="text-primary hover:underline">Speckit-Tab</NuxtLink>,
            dann erscheinen hier Live-Status, Org-Chart und History.
          </CardContent>
        </Card>

        <template v-else>
          <Card>
            <CardHeader>
              <div class="flex items-center gap-2">
                <Activity class="size-4 text-primary" />
                <CardTitle class="text-base">Live Status</CardTitle>
              </div>
              <p class="text-xs text-muted-foreground">
                Aktive Agents · {{ companyStatus?.agents?.length ?? 0 }} Rollen ·
                Queue-Tiefe: {{ companyStatus?.queueDepth ?? 0 }} · Pending: {{ pendingDispatches.length }}
              </p>
            </CardHeader>
            <CardContent class="space-y-2">
              <div v-if="pendingDispatches.length === 0" class="text-sm text-muted-foreground">
                Keine laufenden Dispatches.
              </div>
              <div
                v-for="p in pendingDispatches"
                :key="p.id"
                class="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm"
              >
                <div>
                  <span class="font-medium">{{ p.role }}</span>
                  <span class="ml-2 text-xs text-muted-foreground">{{ shortPath(p.task_path) }}</span>
                </div>
                <span class="text-xs text-muted-foreground">seit {{ relativeTime(p.at) }}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div class="flex items-center gap-2">
                <Network class="size-4 text-primary" />
                <CardTitle class="text-base">Org Chart</CardTitle>
              </div>
              <p class="text-xs text-muted-foreground">
                Hierarchie aus <code>reports_to</code> · Workflow-Edges aus <code>delivers_to</code>
              </p>
            </CardHeader>
            <CardContent class="space-y-3">
              <div v-for="root in orgRoots" :key="root.role" class="space-y-2">
                <div class="rounded-md bg-primary/10 px-3 py-2">
                  <div class="font-medium">{{ root.role }}</div>
                  <div v-if="root.delivers_to.length" class="mt-1 text-xs text-muted-foreground">
                    liefert an: {{ root.delivers_to.join(", ") }}
                  </div>
                </div>
                <div
                  v-if="childrenOf(root.role).length"
                  class="ml-6 space-y-2 border-l border-muted pl-4"
                >
                  <div
                    v-for="child in childrenOf(root.role)"
                    :key="child.role"
                    class="rounded-md border bg-muted/30 px-3 py-2"
                  >
                    <div class="font-medium">{{ child.role }}</div>
                    <div v-if="child.delivers_to.length" class="mt-1 text-xs text-muted-foreground">
                      liefert an: {{ child.delivers_to.join(", ") }}
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div class="flex items-center gap-2">
                <History class="size-4 text-primary" />
                <CardTitle class="text-base">History</CardTitle>
              </div>
              <p class="text-xs text-muted-foreground">
                JSONL Event Log · letzte 50 Events · alle 5s aktualisiert
              </p>
            </CardHeader>
            <CardContent>
              <div v-if="eventsError" class="text-sm text-amber-600">{{ eventsError }}</div>
              <div v-else-if="!events.length" class="text-sm text-muted-foreground">
                Noch keine Events.
              </div>
              <div v-else class="space-y-1 font-mono text-xs">
                <div
                  v-for="e in events"
                  :key="e.id"
                  class="flex items-baseline gap-2 rounded px-2 py-1 hover:bg-muted/50"
                >
                  <Circle class="size-2 shrink-0 fill-current" :class="eventDotColor(e.type)" />
                  <span class="w-12 shrink-0 text-muted-foreground">{{ relativeTime(e.at) }}</span>
                  <span class="w-44 shrink-0 truncate">{{ e.type }}</span>
                  <span v-if="e.role" class="w-20 shrink-0 text-foreground">{{ e.role }}</span>
                  <span class="truncate text-muted-foreground">{{ shortPath(e.task_path) }}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </template>
  </ProjectShell>
</template>
