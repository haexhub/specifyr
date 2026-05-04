<script setup lang="ts">
import { Activity, Network, History, Circle, LayoutList, Send, Square } from "lucide-vue-next";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import ProjectShell from "~/components/ProjectShell.vue";
import AgentDetailDrawer from "~/components/AgentDetailDrawer.vue";
import AgentTaskBoard from "~/components/AgentTaskBoard.vue";
import { resolveWorkflow, type Workflow } from "~/lib/workflows";

const route = useRoute();
const router = useRouter();
const slug = computed(() => route.params.slug as string);

const selectedRole = computed(() => {
  const v = route.query.agent;
  return typeof v === "string" && v.length > 0 ? v : null;
});

function selectAgent(role: string) {
  router.replace({ query: { ...route.query, agent: role } });
}

function closeDetail() {
  const next = { ...route.query };
  delete next.agent;
  router.replace({ query: next });
}

interface TaskSummary {
  path: string;
  title: string | null;
}

interface AgentStatus {
  role: string;
  capabilities: string[];
  resources: { cpus?: string; memory?: string } | null;
  reports_to: string | null;
  delivers_to: string[];
  activeTask: TaskSummary | null;
  queuedTasks: TaskSummary[];
}

interface CompanyStatus {
  slug: string;
  status: "running" | "idle" | "stopped";
  startedAt?: string | null;
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

const runStep = computed(() => {
  const steps = workflow.value.steps;
  return steps.find((s) => s.isRun) ?? steps[steps.length - 1]!;
});

const { data: companyStatus, refresh: refreshStatus } = await useFetch<CompanyStatus>(
  () => `/api/projects/${slug.value}/company/status`,
  {
    default: () => ({ slug: slug.value, status: "idle" } as CompanyStatus),
    key: () => `cstatus-${slug.value}`,
  },
);

const isRunning = computed(() => companyStatus.value?.status === "running");

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

// Only show failures from the current company session — older entries are
// historical noise; the dedicated /history view exposes them on demand.
const recentFailures = computed(() => {
  const startedAt = companyStatus.value?.startedAt;
  if (!startedAt) return [];
  const since = new Date(startedAt).getTime();
  return events.value
    .filter((e) => e.type === "dispatch-failed" || e.type === "dispatch-error")
    .filter((e) => new Date(e.at).getTime() >= since)
    .slice(0, 5);
});

const orgRoots = computed<AgentStatus[]>(() => {
  const agents = companyStatus.value?.agents ?? [];
  return agents.filter((a) => a.reports_to == null);
});

function childrenOf(parentRole: string): AgentStatus[] {
  const agents = companyStatus.value?.agents ?? [];
  return agents.filter((a) => a.reports_to === parentRole);
}

const selectedAgent = computed<AgentStatus | null>(() => {
  if (!selectedRole.value) return null;
  const agents = companyStatus.value?.agents ?? [];
  return agents.find((a) => a.role === selectedRole.value) ?? null;
});

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

const showDispatch = ref(false);
const dispatchGoal = ref("");
const dispatchTitle = ref("");
const dispatchLoading = ref(false);
const dispatchFeedback = ref<{ ok: boolean; msg: string } | null>(null);

const stopLoading = ref(false);
async function stopCompany() {
  if (!confirm(t("runtime.stopConfirm"))) return;
  stopLoading.value = true;
  try {
    await $fetch(`/api/projects/${slug.value}/company/stop`, { method: "POST" });
    await refreshStatus();
    events.value = [];
  } catch (err: unknown) {
    alert(err instanceof Error ? err.message : String(err));
  } finally {
    stopLoading.value = false;
  }
}

const { t } = useI18n();

async function submitDispatch() {
  dispatchLoading.value = true;
  dispatchFeedback.value = null;
  try {
    await $fetch(`/api/projects/${slug.value}/company/dispatch`, {
      method: "POST",
      body: { goal: dispatchGoal.value, title: dispatchTitle.value || undefined },
    });
    dispatchFeedback.value = { ok: true, msg: t("runtime.dispatchSuccess") };
    dispatchGoal.value = "";
    dispatchTitle.value = "";
    await refreshStatus();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    dispatchFeedback.value = { ok: false, msg: t("runtime.dispatchError", { msg }) };
  } finally {
    dispatchLoading.value = false;
  }
}

function closeDispatch() {
  showDispatch.value = false;
  dispatchFeedback.value = null;
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
        <p class="font-medium text-foreground">{{ $t("runtime.sidebarTitle") }}</p>
        <div class="flex items-center gap-2">
          <Circle
            class="size-2 fill-current"
            :class="isRunning ? 'text-green-500' : 'text-muted-foreground'"
          />
          <span class="font-medium text-foreground">{{ companyStatus?.status ?? "idle" }}</span>
        </div>
        <div v-if="isRunning" class="space-y-1">
          <p>
            {{ $t("runtime.sidebarAgents") }} <span class="font-medium text-foreground">{{ companyStatus?.agents?.length ?? 0 }}</span>
          </p>
          <p>
            {{ $t("runtime.sidebarQueueDepth") }} <span class="font-medium text-foreground">{{ companyStatus?.queueDepth ?? 0 }}</span>
          </p>
          <p>
            {{ $t("runtime.sidebarPending") }} <span class="font-medium text-foreground">{{ pendingDispatches.length }}</span>
          </p>
        </div>
      </div>
    </template>

    <header class="flex flex-wrap items-center justify-end gap-3">
      <NuxtLink
        :to="`/specs/${slug}/history`"
        class="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted/40"
      >
        <History class="size-3.5" />
        {{ $t("runtime.historyBtn") }}
      </NuxtLink>
      <button
        v-if="isRunning"
        type="button"
        :disabled="stopLoading"
        class="inline-flex items-center gap-1.5 rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:border-red-700 dark:text-red-400"
        @click="stopCompany"
      >
        <Square class="size-3.5" />
        {{ stopLoading ? "…" : $t("runtime.stopBtn") }}
      </button>
      <button
        v-if="isRunning"
        type="button"
        class="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        @click="showDispatch = true"
      >
        <Send class="size-3.5" />
        {{ $t("runtime.dispatchBtn") }}
      </button>
      <Badge :variant="isRunning ? 'default' : 'secondary'">
        <Circle
          class="mr-1 size-2 fill-current"
          :class="isRunning ? 'text-green-500' : 'text-muted-foreground'"
        />
        {{ companyStatus?.status ?? "idle" }}
      </Badge>
    </header>

    <!-- Dispatch dialog -->
    <Teleport to="body">
      <div
        v-if="showDispatch"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        @click.self="closeDispatch"
      >
        <div class="w-full max-w-md rounded-lg border bg-background p-6 shadow-xl">
          <h2 class="mb-4 text-base font-semibold">{{ $t("runtime.dispatchTitle") }}</h2>
          <form class="space-y-3" @submit.prevent="submitDispatch">
            <div>
              <label class="mb-1 block text-xs font-medium text-muted-foreground">{{ $t("runtime.dispatchGoalLabel") }}</label>
              <textarea
                v-model="dispatchGoal"
                rows="4"
                required
                class="w-full rounded-md border bg-muted/30 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                :placeholder="$t('runtime.dispatchGoalPlaceholder')"
              />
            </div>
            <div>
              <label class="mb-1 block text-xs font-medium text-muted-foreground">{{ $t("runtime.dispatchTitleLabel") }}</label>
              <input
                v-model="dispatchTitle"
                type="text"
                class="w-full rounded-md border bg-muted/30 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                :placeholder="$t('runtime.dispatchTitlePlaceholder')"
              />
            </div>
            <div
              v-if="dispatchFeedback"
              class="rounded-md px-3 py-2 text-sm"
              :class="dispatchFeedback.ok ? 'bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-red-500/10 text-red-700 dark:text-red-400'"
            >
              {{ dispatchFeedback.msg }}
            </div>
            <div class="flex justify-end gap-2">
              <button
                type="button"
                class="rounded-md border px-3 py-1.5 text-sm hover:bg-muted/50"
                @click="closeDispatch"
              >
                {{ $t("runtime.dispatchCancel") }}
              </button>
              <button
                type="submit"
                :disabled="dispatchLoading"
                class="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                <Send class="size-3.5" />
                {{ dispatchLoading ? "…" : $t("runtime.dispatchSend") }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>

        <Card v-if="!isRunning">
          <CardContent class="py-10 text-center text-sm text-muted-foreground">
            <p>{{ $t("runtime.idlePre") }}
            <NuxtLink :to="`/specs/${slug}`" class="text-primary hover:underline">{{ $t("runtime.speckit") }}</NuxtLink>{{ $t("runtime.idlePost") }}</p>
            <div class="mt-4">
              <NuxtLink
                :to="`/specs/${slug}/run`"
                class="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {{ $t("runtime.startNow") }}
              </NuxtLink>
            </div>
          </CardContent>
        </Card>

        <template v-else>
          <Card>
            <CardHeader>
              <div class="flex items-center gap-2">
                <Activity class="size-4 text-primary" />
                <CardTitle class="text-base">{{ $t("runtime.liveStatus") }}</CardTitle>
              </div>
              <p class="text-xs text-muted-foreground">
                {{ $t("runtime.liveStatusDesc", { agents: companyStatus?.agents?.length ?? 0, depth: companyStatus?.queueDepth ?? 0, pending: pendingDispatches.length }) }}
              </p>
            </CardHeader>
            <CardContent class="space-y-2">
              <div v-if="pendingDispatches.length === 0" class="text-sm text-muted-foreground">
                {{ $t("runtime.noDispatches") }}
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
                <span class="text-xs text-muted-foreground">{{ $t("runtime.since", { time: relativeTime(p.at) }) }}</span>
              </div>

              <!-- Recent failures — shown prominently so the cause is visible -->
              <template v-if="recentFailures.length > 0">
                <div class="mt-3 border-t pt-3">
                  <p class="mb-2 text-xs font-medium text-red-600 dark:text-red-400">{{ $t("runtime.recentFailures") }}</p>
                  <div
                    v-for="f in recentFailures"
                    :key="f.id"
                    class="mb-2 rounded-md border border-red-300/40 bg-red-500/5 px-3 py-2 text-xs"
                  >
                    <div class="flex items-center justify-between">
                      <span class="font-medium text-red-700 dark:text-red-400">{{ f.role }} · {{ f.type }}</span>
                      <span class="text-muted-foreground">{{ relativeTime(f.at) }}</span>
                    </div>
                    <div v-if="f.payload?.summary" class="mt-1 font-mono text-red-800/80 dark:text-red-300/80">{{ f.payload.summary }}</div>
                    <div v-if="f.payload?.transcript" class="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">{{ f.payload.transcript }}</div>
                  </div>
                </div>
              </template>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div class="flex items-center gap-2">
                <Network class="size-4 text-primary" />
                <CardTitle class="text-base">{{ $t("runtime.orgChartTitle") }}</CardTitle>
              </div>
              <p class="text-xs text-muted-foreground">
                {{ $t("runtime.orgChartDescPre") }} <code>reports_to</code> {{ $t("runtime.orgChartDescMid") }} <code>delivers_to</code>
              </p>
            </CardHeader>
            <CardContent class="space-y-3">
              <div v-for="root in orgRoots" :key="root.role" class="space-y-2">
                <button
                  type="button"
                  class="block w-full rounded-md bg-primary/10 px-3 py-2 text-left transition hover:bg-primary/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  :class="{ 'ring-2 ring-primary': selectedRole === root.role }"
                  @click="selectAgent(root.role)"
                >
                  <div class="font-medium">{{ root.role }}</div>
                  <div v-if="root.delivers_to.length" class="mt-1 text-xs text-muted-foreground">
                    {{ $t("runtime.deliversTo") }} {{ root.delivers_to.join(", ") }}
                  </div>
                </button>
                <div
                  v-if="childrenOf(root.role).length"
                  class="ml-6 space-y-2 border-l border-muted pl-4"
                >
                  <button
                    v-for="child in childrenOf(root.role)"
                    :key="child.role"
                    type="button"
                    class="block w-full rounded-md border bg-muted/30 px-3 py-2 text-left transition hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    :class="{ 'ring-2 ring-primary': selectedRole === child.role }"
                    @click="selectAgent(child.role)"
                  >
                    <div class="font-medium">{{ child.role }}</div>
                    <div v-if="child.delivers_to.length" class="mt-1 text-xs text-muted-foreground">
                      {{ $t("runtime.deliversTo") }} {{ child.delivers_to.join(", ") }}
                    </div>
                  </button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div class="flex items-center gap-2">
                <LayoutList class="size-4 text-primary" />
                <CardTitle class="text-base">{{ $t("taskBoard.title") }}</CardTitle>
              </div>
              <p class="text-xs text-muted-foreground">{{ $t("taskBoard.desc") }}</p>
            </CardHeader>
            <CardContent>
              <AgentTaskBoard
                :agents="companyStatus?.agents ?? []"
                :events="events"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div class="flex items-center gap-2">
                <History class="size-4 text-primary" />
                <CardTitle class="text-base">{{ $t("runtime.historyTitle") }}</CardTitle>
              </div>
              <p class="text-xs text-muted-foreground">
                {{ $t("runtime.historyDesc") }}
              </p>
            </CardHeader>
            <CardContent>
              <div v-if="eventsError" class="text-sm text-amber-600">{{ eventsError }}</div>
              <div v-else-if="!events.length" class="text-sm text-muted-foreground">
                {{ $t("runtime.noEvents") }}
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

    <AgentDetailDrawer
      :agent="selectedAgent"
      :events="events"
      :pending-dispatches="pendingDispatches"
      @close="closeDetail"
    />
  </ProjectShell>
</template>
