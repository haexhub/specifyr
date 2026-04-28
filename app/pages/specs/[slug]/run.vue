<script setup lang="ts">
import { Rocket, Lock, Play, Square, Loader2, RefreshCw } from "lucide-vue-next";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import ProjectStepSidebar from "~/components/ProjectStepSidebar.vue";
import RunTaskList, { type RunTaskRow } from "~/components/RunTaskList.vue";
import RunTaskDetail, { type TaskLogEntry } from "~/components/RunTaskDetail.vue";
import { openSse } from "~/lib/sse-client";
import { isStepUnlocked, type StepId, type StepStatus } from "~/lib/steps";
import { resolveWorkflow, type Workflow } from "~/lib/workflows";
import type { StepState } from "~/lib/types";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const slug = computed(() => route.params.slug as string);

const { data: project } = await useFetch<{
  workflow?: string;
  workflowDefinition?: Workflow;
  title?: string;
}>(() => `/api/projects/${slug.value}`, { key: () => `project-${slug.value}` });

const workflow = computed(() =>
  resolveWorkflow(project.value?.workflow, project.value?.workflowDefinition ?? null)
);
const workflowSteps = computed(() => workflow.value.steps);

const runStep = computed(() => workflowSteps.value.find((s) => s.isRun) ?? workflowSteps.value[workflowSteps.value.length - 1]!);
const tasksStep = computed(() => {
  const idx = workflowSteps.value.findIndex((s) => s.id === runStep.value.id);
  return idx > 0 ? workflowSteps.value[idx - 1]! : runStep.value;
});

const { data: stepStates } = await useFetch<StepState[]>(
  () => `/api/projects/${slug.value}/steps`,
  { default: () => [], key: () => `steps-${slug.value}` }
);

const statusMap = computed(() => {
  const map: Record<StepId, StepStatus | undefined> = {};
  for (const step of workflowSteps.value) map[step.id] = undefined;
  for (const s of stepStates.value ?? []) map[s.id] = s.status;
  return map;
});
const unlocked = computed(() => isStepUnlocked(runStep.value.id, statusMap.value, workflowSteps.value));

interface GraphTask {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
  parallelSafe: boolean;
  category?: string;
}

interface RunStateSnapshot {
  slug: string;
  status: "idle" | "running" | "paused" | "completed" | "failed";
  startedAt: string | null;
  completedAt: string | null;
  currentTaskId: string | null;
  tasks: Record<
    string,
    {
      id: string;
      status: RunTaskRow["status"];
      startedAt: string | null;
      completedAt: string | null;
      retries: number;
      lastError: string | null;
      summary?: string;
    }
  >;
}

interface RunStatusResponse {
  slug: string;
  running: boolean;
  current: RunStateSnapshot | null;
  graph: { tasks: GraphTask[] } | null;
}

const status = ref<RunStatusResponse | null>(null);
const starting = ref(false);
const cancelling = ref(false);
const startError = ref<string | null>(null);
const streaming = ref(false);
const abortCtrl = ref<AbortController | null>(null);

const activeTaskId = ref<string | null>(null);
const liveText = ref("");
const taskLogs = ref<Record<string, TaskLogEntry[]>>({});

async function refreshStatus() {
  try {
    status.value = await $fetch<RunStatusResponse>(`/api/projects/${slug.value}/run/status`);
  } catch (err) {
    startError.value = err instanceof Error ? err.message : String(err);
  }
}

async function loadTaskLog(taskId: string) {
  try {
    const res = await $fetch<{ entries: TaskLogEntry[] }>(
      `/api/projects/${slug.value}/run/tasks/${taskId}/log`
    );
    taskLogs.value[taskId] = res.entries ?? [];
  } catch {
    taskLogs.value[taskId] = [];
  }
}

onMounted(async () => {
  await refreshStatus();
  const tasks = status.value?.graph?.tasks ?? [];
  if (tasks.length > 0) {
    activeTaskId.value = tasks[0]!.id;
    await loadTaskLog(tasks[0]!.id);
  }
});

const rows = computed<RunTaskRow[]>(() => {
  const graph = status.value?.graph?.tasks ?? [];
  const state = status.value?.current?.tasks ?? {};
  return graph.map((t) => {
    const s = state[t.id];
    return {
      id: t.id,
      title: t.title,
      status: (s?.status ?? "pending") as RunTaskRow["status"],
      dependsOn: t.dependsOn,
      summary: s?.summary,
      lastError: s?.lastError ?? undefined,
      parallelSafe: t.parallelSafe
    };
  });
});

const activeTask = computed<RunTaskRow | null>(
  () => rows.value.find((t) => t.id === activeTaskId.value) ?? null
);

async function selectTask(taskId: string) {
  activeTaskId.value = taskId;
  liveText.value = "";
  if (!taskLogs.value[taskId]) {
    await loadTaskLog(taskId);
  }
}

function patchTaskStatus(taskId: string, patch: Partial<RunStateSnapshot["tasks"][string]>) {
  if (!status.value?.current) return;
  const existing = status.value.current.tasks[taskId] ?? {
    id: taskId,
    status: "pending" as const,
    startedAt: null,
    completedAt: null,
    retries: 0,
    lastError: null
  };
  status.value.current.tasks[taskId] = { ...existing, ...patch };
}

function pushLog(taskId: string, entry: TaskLogEntry) {
  if (!taskLogs.value[taskId]) taskLogs.value[taskId] = [];
  taskLogs.value[taskId]!.push(entry);
}

async function startRun() {
  if (starting.value || streaming.value) return;
  starting.value = true;
  startError.value = null;
  liveText.value = "";
  taskLogs.value = {};

  const ctrl = new AbortController();
  abortCtrl.value = ctrl;
  streaming.value = true;

  try {
    await openSse(`/api/projects/${slug.value}/run/start`, {
      method: "POST",
      body: {},
      signal: ctrl.signal,
      onEvent: async (ev) => {
        let payload: any = {};
        try {
          payload = JSON.parse(ev.data);
        } catch {
          /* ignore malformed */
        }
        switch (ev.event) {
          case "run_started":
            await refreshStatus();
            break;
          case "task_started": {
            const taskId = payload.taskId;
            activeTaskId.value = taskId;
            liveText.value = "";
            patchTaskStatus(taskId, { status: "running", startedAt: new Date().toISOString() });
            pushLog(taskId, {
              ts: new Date().toISOString(),
              kind: "start",
              title: rows.value.find((r) => r.id === taskId)?.title
            });
            break;
          }
          case "task_chunk":
            if (payload.taskId === activeTaskId.value) {
              liveText.value += payload.text;
            }
            break;
          case "task_completed":
            patchTaskStatus(payload.taskId, {
              status: "completed",
              summary: payload.summary,
              completedAt: new Date().toISOString()
            });
            pushLog(payload.taskId, {
              ts: new Date().toISOString(),
              kind: "complete",
              summary: payload.summary
            });
            if (payload.taskId === activeTaskId.value) liveText.value = "";
            break;
          case "task_failed":
            patchTaskStatus(payload.taskId, {
              status: "failed",
              lastError: payload.error,
              completedAt: new Date().toISOString()
            });
            pushLog(payload.taskId, {
              ts: new Date().toISOString(),
              kind: "failed",
              error: payload.error
            });
            if (payload.taskId === activeTaskId.value) liveText.value = "";
            break;
          case "task_blocked":
            patchTaskStatus(payload.taskId, {
              status: "blocked_by_upstream",
              lastError: `Upstream: ${payload.upstream}`
            });
            break;
          case "run_paused":
          case "run_completed":
            await refreshStatus();
            break;
          case "error":
            startError.value = payload?.message ?? t("run.unknownError");
            break;
          case "done":
            break;
        }
      },
      onError: (err) => {
        startError.value = err instanceof Error ? err.message : String(err);
      },
      onClose: async () => {
        streaming.value = false;
        abortCtrl.value = null;
        await refreshStatus();
      }
    });
  } catch (err) {
    startError.value = err instanceof Error ? err.message : String(err);
    streaming.value = false;
  } finally {
    starting.value = false;
  }
}

async function cancelRun() {
  if (cancelling.value) return;
  cancelling.value = true;
  try {
    await $fetch(`/api/projects/${slug.value}/run/cancel`, { method: "POST" });
    abortCtrl.value?.abort();
  } catch (err) {
    alert(err instanceof Error ? err.message : t("run.cancelFailed"));
  } finally {
    cancelling.value = false;
  }
}

const taskBusy = ref(false);

async function retryTask(taskId: string) {
  if (taskBusy.value) return;
  taskBusy.value = true;
  try {
    await $fetch(`/api/projects/${slug.value}/run/tasks/${taskId}/retry`, { method: "POST" });
    await refreshStatus();
    taskLogs.value[taskId] = [];
  } catch (err) {
    alert(err instanceof Error ? err.message : t("run.retryFailed"));
  } finally {
    taskBusy.value = false;
  }
}

async function skipTask(taskId: string) {
  if (taskBusy.value) return;
  taskBusy.value = true;
  try {
    await $fetch(`/api/projects/${slug.value}/run/tasks/${taskId}/skip`, { method: "POST" });
    await refreshStatus();
  } catch (err) {
    alert(err instanceof Error ? err.message : t("run.skipFailed"));
  } finally {
    taskBusy.value = false;
  }
}

onUnmounted(() => {
  abortCtrl.value?.abort();
});
</script>

<template>
  <div class="flex h-screen">
    <ProjectStepSidebar
      :slug="slug"
      :project-title="project?.title"
      :active-step-id="runStep.id"
      :workflow="workflow"
    >
      <div class="px-3 py-3 text-xs text-muted-foreground">
        <p class="font-medium text-foreground">{{ $t("run.runStatus") }}</p>
        <p v-if="status?.current" class="mt-1">
          <Badge :variant="status.current.status === 'completed' ? 'default' : 'secondary'" class="align-middle">
            {{ status.current.status }}
          </Badge>
        </p>
        <p v-else class="mt-1 italic opacity-70">{{ $t("run.notStarted") }}</p>
      </div>
    </ProjectStepSidebar>

    <section v-if="!unlocked" class="flex h-screen flex-1 items-center justify-center p-8">
      <div class="max-w-md text-center">
        <div class="mx-auto mb-4 inline-flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Lock class="size-6" />
        </div>
        <h1 class="text-xl font-semibold">{{ $t("run.locked") }}</h1>
        <p class="mt-2 text-sm text-muted-foreground">
          {{ $t("run.lockedDesc", { label: tasksStep.label }) }}
        </p>
        <Button class="mt-5" @click="router.push(`/specs/${slug}/steps/tasks`)">
          {{ $t("run.switchTo", { label: tasksStep.label }) }}
        </Button>
      </div>
    </section>

    <div v-else class="flex h-screen flex-1 flex-col">
      <header class="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-6 py-3">
        <div class="flex items-center gap-3">
          <div class="inline-flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Rocket class="size-4" />
          </div>
          <div>
            <p class="text-[11px] uppercase tracking-wider text-muted-foreground">{{ $t("run.stepLabel") }}</p>
            <h1 class="text-lg font-semibold">{{ $t("run.implement") }}</h1>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <Button
            v-if="!streaming"
            size="sm"
            :disabled="starting"
            @click="startRun"
          >
            <Loader2 v-if="starting" class="mr-1.5 size-3.5 animate-spin" />
            <Play v-else class="mr-1.5 size-3.5" />
            {{ starting ? $t("run.starting") : (status?.current ? $t("run.restart") : $t("run.startRun")) }}
          </Button>
          <Button
            v-else
            size="sm"
            variant="destructive"
            :disabled="cancelling"
            @click="cancelRun"
          >
            <Square class="mr-1.5 size-3.5" />
            {{ cancelling ? $t("run.cancelling") : $t("run.cancel") }}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            :disabled="streaming"
            @click="refreshStatus"
          >
            <RefreshCw class="size-3.5" />
          </Button>
        </div>
      </header>

      <div
        v-if="startError"
        class="border-b border-destructive/40 bg-destructive/5 px-6 py-2 text-xs text-destructive"
      >
        {{ startError }}
      </div>

      <div class="flex flex-1 overflow-hidden">
        <aside class="flex w-[340px] shrink-0 flex-col border-r border-border/60">
          <div class="border-b border-border/60 px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Tasks
            <span v-if="rows.length" class="normal-case"> · {{ rows.length }} {{ $t("common.total") }}</span>
          </div>
          <div class="flex-1 overflow-y-auto">
            <RunTaskList
              v-if="rows.length"
              :tasks="rows"
              :active-task-id="activeTaskId"
              @select="selectTask"
            />
            <p v-else class="p-4 text-xs text-muted-foreground">
              {{ $t("run.noTaskGraph") }}
            </p>
          </div>
        </aside>

        <div class="flex-1 overflow-hidden">
          <RunTaskDetail
            :task="activeTask"
            :log="activeTaskId ? taskLogs[activeTaskId] ?? [] : []"
            :live-text="liveText"
            :streaming="streaming && activeTaskId === status?.current?.currentTaskId"
            :run-active="streaming"
            :busy="taskBusy"
            @retry="retryTask"
            @skip="skipTask"
          />
        </div>
      </div>
    </div>
  </div>
</template>
