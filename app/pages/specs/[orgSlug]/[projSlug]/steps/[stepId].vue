<script setup lang="ts">
import { PanelRightOpen, Play } from "lucide-vue-next";
import { Badge } from "~/components/shadcn/badge";
import { Button } from "~/components/shadcn/button";
import ProjectStepSidebar from "~/components/projects/ProjectStepSidebar.vue";
import SessionList from "~/components/ui/SessionList.vue";
import ChatStream from "~/components/ui/ChatStream.vue";
import ArtifactViewer from "~/components/ui/ArtifactViewer.vue";
import HookGateBanner from "~/components/common/HookGateBanner.vue";
import { stepById, type StepId, type StepStatus } from "~/utils/steps";
import { resolveWorkflow, type Workflow, type WorkflowStep } from "~/utils/workflows";
import { gatesForStep } from "~/utils/hooks";
import type { SessionMetadata, StepState } from "~/types/types";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const orgSlug = computed(() => route.params.orgSlug as string);
const projSlug = computed(() => route.params.projSlug as string);
const apiBase = computed(() => `/api/orgs/${orgSlug.value}/projects/${projSlug.value}`);
const stepIdParam = computed(() => route.params.stepId as string);
const activeSessionId = computed(() => {
  const q = route.query.session;
  return typeof q === "string" && q.length > 0 ? q : null;
});

const { data: project } = await useFetch<{
  workflow?: string;
  workflowDefinition?: Workflow;
  title?: string;
}>(() => apiBase.value, { key: () => `project-${orgSlug.value}-${projSlug.value}` });

const workflow = computed(() =>
  resolveWorkflow(project.value?.workflow, project.value?.workflowDefinition ?? null)
);
const workflowSteps = computed(() => workflow.value.steps);

const step = computed(() => {
  try {
    return stepById(stepIdParam.value as StepId, workflowSteps.value);
  } catch {
    return null;
  }
});
const stepIndex = computed(() =>
  workflowSteps.value.findIndex((s: WorkflowStep) => s.id === stepIdParam.value)
);

const sessions = ref<SessionMetadata[]>([]);
const sessionsLoading = ref(false);
const creatingSession = ref(false);
const deleteSessionTarget = ref<SessionMetadata | null>(null);
const deletingSession = ref(false);
const artifactReloadToken = ref(0);
const artifactOpen = ref(true);
const chatStreamRef = ref<{ insertIntoDraft: (text: string) => void } | null>(null);

const ARTIFACT_WIDTH_KEY = "specifyr:artifact-sidebar-width";
const ARTIFACT_WIDTH_MIN = 320;
const ARTIFACT_WIDTH_MAX = 960;
const ARTIFACT_WIDTH_DEFAULT = 420;

const artifactWidth = ref(ARTIFACT_WIDTH_DEFAULT);
const artifactResizing = ref(false);

onMounted(() => {
  const stored = Number.parseInt(localStorage.getItem(ARTIFACT_WIDTH_KEY) ?? "", 10);
  if (Number.isFinite(stored)) {
    artifactWidth.value = Math.min(Math.max(stored, ARTIFACT_WIDTH_MIN), ARTIFACT_WIDTH_MAX);
  }
});

function startArtifactResize(event: MouseEvent) {
  event.preventDefault();
  artifactResizing.value = true;
  const startX = event.clientX;
  const startWidth = artifactWidth.value;
  function onMove(e: MouseEvent) {
    const next = startWidth - (e.clientX - startX);
    artifactWidth.value = Math.min(Math.max(next, ARTIFACT_WIDTH_MIN), ARTIFACT_WIDTH_MAX);
  }
  function onUp() {
    artifactResizing.value = false;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    localStorage.setItem(ARTIFACT_WIDTH_KEY, String(Math.round(artifactWidth.value)));
  }
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function handlePowerPrompt(prompt: string) {
  chatStreamRef.value?.insertIntoDraft(prompt);
}

function handleGateUseCommand(command: string) {
  chatStreamRef.value?.insertIntoDraft(`${command} `);
}

interface ExtensionRecord {
  slug: string;
  status: string;
}

const { data: extensionsManifest } = await useFetch<{ extensions: ExtensionRecord[] }>(
  () => `${apiBase.value}/extensions`,
  { default: () => ({ extensions: [] }), key: () => `ext-${orgSlug.value}-${projSlug.value}` }
);

const installedSlugs = computed(() =>
  (extensionsManifest.value?.extensions ?? [])
    .filter((e) => e.status === "installed")
    .map((e) => e.slug)
);

const hookGates = computed(() => {
  if (!step.value) return [];
  return gatesForStep(step.value.id, installedSlugs.value);
});

const stepStates = ref<StepState[]>([]);
const statusMap = computed(() => {
  const map: Record<StepId, StepStatus | undefined> = {};
  for (const wfStep of workflowSteps.value) map[wfStep.id] = undefined;
  for (const s of stepStates.value) map[s.id] = s.status;
  return map;
});

const currentStepStatus = computed<StepStatus | undefined>(() =>
  step.value ? statusMap.value[step.value.id] : undefined
);

const activeSession = computed(() =>
  sessions.value.find((s: SessionMetadata) => s.id === activeSessionId.value) ?? null
);

async function loadStepStates() {
  stepStates.value = await $fetch<StepState[]>(`${apiBase.value}/steps`);
  await refreshNuxtData(`steps-${orgSlug.value}-${projSlug.value}`);
}

async function loadSessions() {
  if (!projSlug.value || !stepIdParam.value) return;
  sessionsLoading.value = true;
  try {
    sessions.value = await $fetch<SessionMetadata[]>(
      `${apiBase.value}/steps/${stepIdParam.value}/sessions`
    );
  } finally {
    sessionsLoading.value = false;
  }
}

function sessionStorageKey(orgSlugVal: string, projSlugVal: string, stepIdVal: string) {
  return `specifyr:last-session:${orgSlugVal}:${projSlugVal}:${stepIdVal}`;
}

function getStoredSessionId(orgSlugVal: string, projSlugVal: string, stepIdVal: string): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(sessionStorageKey(orgSlugVal, projSlugVal, stepIdVal));
}

function storeSessionId(orgSlugVal: string, projSlugVal: string, stepIdVal: string, sessionId: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(sessionStorageKey(orgSlugVal, projSlugVal, stepIdVal), sessionId);
}

async function ensureActiveSession() {
  if (activeSessionId.value) return;
  const stored = getStoredSessionId(orgSlug.value, projSlug.value, stepIdParam.value);
  if (stored) {
    const found = sessions.value.find((s: SessionMetadata) => s.id === stored);
    if (found) {
      await selectSession(found.id);
      return;
    }
  }
  if (sessions.value.length > 0) {
    await selectSession(sessions.value[0]!.id);
    return;
  }
  if (creatingSession.value) return;
  await createSession();
}

async function createSession() {
  if (creatingSession.value) return;
  creatingSession.value = true;
  try {
    const created = await $fetch<SessionMetadata>(
      `${apiBase.value}/steps/${stepIdParam.value}/sessions`,
      { method: "POST", body: {} }
    );
    sessions.value = [created, ...sessions.value];
    storeSessionId(orgSlug.value, projSlug.value, stepIdParam.value, created.id);
    await router.replace({
      path: route.path,
      query: { ...route.query, session: created.id }
    });
  } catch (err) {
    alert(err instanceof Error ? err.message : t("sessions.sessionCreateError"));
  } finally {
    creatingSession.value = false;
  }
}

async function selectSession(sessionId: string) {
  storeSessionId(orgSlug.value, projSlug.value, stepIdParam.value, sessionId);
  await router.replace({
    path: route.path,
    query: { ...route.query, session: sessionId }
  });
}

function requestDeleteSession(session: SessionMetadata, event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  deleteSessionTarget.value = session;
}

async function confirmDeleteSession() {
  const target = deleteSessionTarget.value;
  if (!target || deletingSession.value) return;
  deletingSession.value = true;
  try {
    await $fetch(
      `${apiBase.value}/steps/${stepIdParam.value}/sessions/${target.id}`,
      { method: "DELETE" }
    );
    sessions.value = sessions.value.filter((s) => s.id !== target.id);
    deleteSessionTarget.value = null;
    // If the deleted session was the active one, drop the ?session= param so
    // ensureActiveSession() falls back to the first remaining session (or
    // creates a fresh one).
    if (activeSessionId.value === target.id) {
      const { session: _drop, ...rest } = route.query;
      await router.replace({ path: route.path, query: rest });
      await ensureActiveSession();
    }
  } catch (err) {
    alert(err instanceof Error ? err.message : t("sessions.sessionDeleteError"));
  } finally {
    deletingSession.value = false;
  }
}

async function onTurnCompleted() {
  artifactReloadToken.value += 1;
  await Promise.all([loadSessions(), loadStepStates()]);
}

const runningAction = ref(false);
const runActionError = ref<string | null>(null);

async function runStepAction() {
  if (!step.value?.runAction || runningAction.value) return;
  runningAction.value = true;
  runActionError.value = null;
  try {
    await $fetch(`${apiBase.value}/${step.value.runAction}`, { method: "POST" });
    artifactReloadToken.value += 1;
  } catch (err) {
    const msg = (err as { data?: { statusMessage?: string }; message?: string })?.data?.statusMessage
      ?? (err instanceof Error ? err.message : String(err));
    runActionError.value = msg;
  } finally {
    runningAction.value = false;
  }
}

watch(
  [orgSlug, projSlug, stepIdParam],
  async () => {
    await loadStepStates();
    await loadSessions();
    await ensureActiveSession();
  },
  { immediate: true }
);

const artifactCandidates = computed(() => step.value?.artifacts ?? []);
const primaryOutput = computed(() => step.value?.artifacts?.[0] ?? null);
const nextStep = computed(() => {
  if (stepIndex.value < 0) return null;
  return workflowSteps.value[stepIndex.value + 1] ?? null;
});
</script>

<template>
  <div v-if="!step" class="p-8 text-sm text-muted-foreground">
    {{ $t("stepDetail.unknownStep", { id: stepIdParam }) }}
  </div>

  <div v-else class="flex h-screen">
    <ProjectsProjectStepSidebar
      :org-slug="orgSlug"
      :proj-slug="projSlug"
      :project-title="project?.title"
      :active-step-id="step.id"
      :workflow="workflow"
    >
      <ClientOnly>
        <UiSessionList
          :org-slug="orgSlug"
          :proj-slug="projSlug"
          :step-id="step.id"
          :sessions="sessions"
          :active-session-id="activeSessionId"
          :loading="sessionsLoading"
          :creating="creatingSession"
          @create="createSession"
          @select="selectSession"
          @delete="requestDeleteSession"
        />
      </ClientOnly>
    </ProjectsProjectStepSidebar>

    <ClientOnly>
      <template #fallback>
        <section class="flex h-screen flex-1 items-center justify-center text-xs text-muted-foreground">
          {{ $t("stepDetail.loadingWorkspace") }}
        </section>
      </template>

    <section class="flex h-screen flex-1 flex-col">
      <header class="flex h-15 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/60 px-6">
        <div>
          <p class="text-[11px] uppercase tracking-wider text-muted-foreground">
            {{ $t("stepDetail.step", { n: stepIndex + 1, total: workflowSteps.length }) }}
          </p>
          <h1 class="text-base font-semibold leading-tight">{{ step.label }}</h1>
        </div>
        <div class="flex items-center gap-2">
          <Badge variant="outline">{{ step.command }}</Badge>
          <Button
            v-if="step.runAction && currentStepStatus !== 'complete'"
            size="sm"
            :disabled="runningAction"
            @click="runStepAction"
          >
            <Play class="mr-1.5 size-3.5" :class="runningAction && 'animate-pulse'" />
            {{ runningAction ? $t("common.loading") : $t("stepDetail.run") }}
          </Button>
        </div>
      </header>

      <div
        v-if="runActionError"
        class="border-b border-destructive/30 bg-destructive/5 px-6 py-2 text-xs text-destructive"
      >
        {{ runActionError }}
      </div>

      <CommonHookGateBanner :gates="hookGates" @use-command="handleGateUseCommand" />

      <div
        v-if="currentStepStatus === 'stale'"
        class="border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-xs text-amber-900 dark:text-amber-200"
      >
        {{ $t("stepDetail.staleWarning") }}
      </div>

      <div class="flex flex-1 flex-col overflow-hidden">
        <UiChatStream
          ref="chatStreamRef"
          :org-slug="orgSlug"
          :proj-slug="projSlug"
          :step-id="step.id"
          :session="activeSession"
          :step-description="step.description"
          :step-output="primaryOutput ?? undefined"
          :next-step-label="nextStep?.label"
          @turn-completed="onTurnCompleted"
        />
      </div>
    </section>

    <aside
      v-if="!artifactOpen"
      class="flex h-screen w-10 shrink-0 flex-col items-center border-l border-border bg-muted/10"
    >
      <div class="flex h-15 shrink-0 items-center justify-center border-b border-border/60">
        <button
          type="button"
          class="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
          :title="$t('stepDetail.showArtifact')"
          @click="artifactOpen = true"
        >
          <PanelRightOpen class="size-4" />
        </button>
      </div>
      <p class="mt-4 rotate-180 text-[10px] font-medium uppercase tracking-[0.25em] text-muted-foreground [writing-mode:vertical-rl]">
        {{ $t("artifact.label") }}
      </p>
    </aside>

    <aside
      v-if="artifactOpen"
      class="relative flex h-screen shrink-0 flex-col border-l border-border bg-muted/10"
      :class="artifactResizing && 'select-none'"
      :style="{ width: `${artifactWidth}px` }"
    >
      <div
        class="group absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize"
        :class="artifactResizing && 'bg-primary/10'"
        @mousedown="startArtifactResize"
      >
        <div
          class="absolute inset-y-0 left-1 w-px transition"
          :class="artifactResizing ? 'bg-primary' : 'bg-transparent group-hover:bg-primary/40'"
        />
      </div>
      <UiArtifactViewer
        :org-slug="orgSlug"
        :proj-slug="projSlug"
        :candidates="artifactCandidates"
        :reload-token="artifactReloadToken"
        @collapse="artifactOpen = false"
        @power-prompt="handlePowerPrompt"
      />
    </aside>
    </ClientOnly>

    <UiConfirmDialog
      :open="deleteSessionTarget !== null"
      :title="deleteSessionTarget ? $t('sessions.deleteTitle', { title: deleteSessionTarget.title }) : ''"
      :message="$t('sessions.deleteMessage')"
      :confirm-label="$t('specIndex.deleteConfirm')"
      destructive
      :busy="deletingSession"
      @confirm="confirmDeleteSession"
      @cancel="deleteSessionTarget = null"
    />
  </div>
</template>
