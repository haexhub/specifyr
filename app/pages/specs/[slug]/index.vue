<script setup lang="ts">
import { ChevronRight, Trash2, Check, Lock, AlertTriangle, Loader2, Activity } from "lucide-vue-next";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import ConfirmDialog from "~/components/ConfirmDialog.vue";
import ProjectStepSidebar from "~/components/ProjectStepSidebar.vue";
import NotificationLogWidget from "~/components/NotificationLogWidget.vue";
import NotificationDrawer from "~/components/NotificationDrawer.vue";
import InstalledExtensionsWidget from "~/components/InstalledExtensionsWidget.vue";
import { isStepUnlocked, type StepId, type StepStatus } from "~/lib/steps";
import { resolveWorkflow, type Workflow } from "~/lib/workflows";
import type { StepState, NotificationEvent } from "~/lib/types";

const route = useRoute();
const router = useRouter();
const refreshProjects = inject<() => Promise<void>>("refreshProjects", async () => {});

const slug = computed(() => route.params.slug as string);
const deleteDialogOpen = ref(false);
const deleting = ref(false);
const notificationDrawerOpen = ref(false);

const { data: project, error } = await useFetch<{
  workflow?: string;
  workflowDefinition?: Workflow;
  title?: string;
  [k: string]: unknown;
}>(() => `/api/projects/${slug.value}`, {
  key: () => `project-${slug.value}`
});

const workflow = computed(() =>
  resolveWorkflow(project.value?.workflow, project.value?.workflowDefinition ?? null)
);
const workflowSteps = computed(() => workflow.value.steps);

// Workflows available for this project: spec-kit + any installed workflow-extension.
// Drives the switcher dropdown. Empty array (spec-kit only) is the common case.
const { data: availableWorkflows } = await useFetch<Workflow[]>(
  () => `/api/projects/${slug.value}/workflows`,
  { default: () => [], key: () => `workflows-${slug.value}` }
);

const { data: stepStates } = await useFetch<StepState[]>(
  () => `/api/projects/${slug.value}/steps`,
  { default: () => [], key: () => `steps-${slug.value}` }
);

const { data: events, pending: eventsLoading } = await useFetch<NotificationEvent[]>(
  () => `/api/projects/${slug.value}/events`,
  { default: () => [], key: () => `events-${slug.value}` }
);

const statusMap = computed(() => {
  const map: Record<StepId, StepStatus | undefined> = {};
  for (const s of workflowSteps.value) map[s.id] = undefined;
  for (const s of stepStates.value ?? []) map[s.id] = s.status;
  return map;
});

const completionStats = computed(() => {
  const statuses = Object.values(statusMap.value);
  const complete = statuses.filter((s) => s === "complete").length;
  const stale = statuses.filter((s) => s === "stale").length;
  return { complete, stale, total: workflowSteps.value.length };
});

function stepRoute(step: { id: string; isRun?: boolean }) {
  if (step.isRun) return `/specs/${slug.value}/run`;
  return `/specs/${slug.value}/steps/${step.id}`;
}

function stepUnlocked(id: StepId): boolean {
  return isStepUnlocked(id, statusMap.value, workflowSteps.value);
}

function stepStatus(id: StepId): StepStatus | undefined {
  return statusMap.value[id];
}

const switchingWorkflow = ref(false);

async function switchWorkflow(event: Event) {
  const target = event.target as HTMLSelectElement;
  const nextId = target.value;
  if (!nextId || nextId === project.value?.workflow) return;
  if (!confirm(`Workflow zu "${nextId}" wechseln?\n\nBestehende Step-States bleiben erhalten, sind aber evtl. nicht mehr auf das neue Workflow anwendbar.`)) {
    // Revert the select value
    target.value = (project.value?.workflow as string) ?? "spec-kit";
    return;
  }
  switchingWorkflow.value = true;
  try {
    await $fetch(`/api/projects/${slug.value}/workflow`, {
      method: "POST",
      body: { workflow: nextId }
    });
    await reloadNuxtApp({ path: route.fullPath });
  } catch (err) {
    alert(err instanceof Error ? err.message : "Workflow-Wechsel fehlgeschlagen.");
    target.value = (project.value?.workflow as string) ?? "spec-kit";
  } finally {
    switchingWorkflow.value = false;
  }
}

async function deleteProject() {
  if (deleting.value) return;
  deleting.value = true;
  try {
    await $fetch(`/api/projects/${slug.value}`, { method: "DELETE" });
    deleteDialogOpen.value = false;
    await refreshProjects();
    await router.push("/");
  } catch (err) {
    alert(err instanceof Error ? err.message : "Löschen fehlgeschlagen.");
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div v-if="error" class="p-8">
    <Card class="mx-auto max-w-lg">
      <CardHeader>
        <CardTitle>Projekt nicht gefunden</CardTitle>
      </CardHeader>
      <CardContent class="text-sm text-muted-foreground">
        Das Projekt <code>{{ slug }}</code> existiert nicht mehr oder kann nicht geladen werden.
      </CardContent>
    </Card>
  </div>

  <div v-else-if="project" class="flex h-screen">
    <ProjectStepSidebar :slug="slug" :project-title="project.title" :workflow="workflow">
      <div class="space-y-2 px-3 py-3 text-xs text-muted-foreground">
        <p class="font-medium text-foreground">Übersicht</p>
        <p>
          Fortschritt:
          <span class="font-medium text-foreground">{{ completionStats.complete }}/{{ completionStats.total }}</span> abgeschlossen
          <span v-if="completionStats.stale" class="ml-1 text-amber-500">
            ({{ completionStats.stale }} veraltet)
          </span>
        </p>
        <p v-if="events?.length">
          <span class="font-medium text-foreground">{{ events.length }}</span> Events gesammelt
        </p>
      </div>
    </ProjectStepSidebar>

    <div class="min-h-screen flex-1 overflow-y-auto p-6 lg:p-10">
      <div class="mx-auto max-w-4xl space-y-6">
        <header class="space-y-2">
          <p class="text-xs uppercase tracking-[0.18em] text-muted-foreground">{{ project.slug }}</p>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h1 class="text-2xl font-semibold tracking-tight">{{ project.title }}</h1>
            <div class="flex items-center gap-2">
              <NuxtLink :to="`/specs/${slug}/runtime`">
                <Button variant="outline" size="sm">
                  <Activity class="mr-1.5 size-3.5" />
                  Runtime-View
                </Button>
              </NuxtLink>
              <Button
                variant="ghost"
                size="sm"
                class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                @click="deleteDialogOpen = true"
              >
                <Trash2 class="mr-1.5 size-3.5" />
                Projekt löschen
              </Button>
            </div>
          </div>
          <p v-if="project.description" class="text-sm leading-6 text-muted-foreground">
            {{ project.description }}
          </p>
        </header>

        <Card>
          <CardHeader>
            <div class="flex items-center justify-between gap-3">
              <CardTitle class="text-base">Workflow</CardTitle>
              <div class="flex items-center gap-2">
                <select
                  :value="project.workflow ?? 'spec-kit'"
                  :disabled="switchingWorkflow"
                  class="rounded-md border border-input bg-background px-2 py-1 text-xs outline-none ring-offset-background transition focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-60"
                  @change="switchWorkflow($event)"
                >
                  <option v-for="wf in availableWorkflows" :key="wf.id" :value="wf.id">
                    {{ wf.label }}
                  </option>
                </select>
              </div>
            </div>
            <p class="text-xs text-muted-foreground">
              {{ workflow.description }}
            </p>
          </CardHeader>
          <CardContent class="space-y-2">
            <template v-for="(step, index) in workflowSteps" :key="step.id">
              <NuxtLink
                v-if="stepUnlocked(step.id)"
                :to="stepRoute(step)"
                class="group flex items-start gap-3 rounded-md border border-border/60 bg-muted/20 p-3 transition hover:border-primary/40 hover:bg-muted/40"
              >
                <span class="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                  {{ index + 1 }}
                </span>
                <div class="flex-1">
                  <p class="text-sm font-medium">{{ step.label }}</p>
                  <p class="text-xs text-muted-foreground">{{ step.summary }}</p>
                </div>
                <span class="flex shrink-0 items-center gap-2">
                  <Check
                    v-if="stepStatus(step.id) === 'complete'"
                    class="size-4 text-emerald-600"
                    title="abgeschlossen"
                  />
                  <Loader2
                    v-else-if="stepStatus(step.id) === 'in_progress'"
                    class="size-4 animate-spin text-primary"
                    title="in Arbeit"
                  />
                  <AlertTriangle
                    v-else-if="stepStatus(step.id) === 'stale'"
                    class="size-4 text-amber-500"
                    title="veraltet"
                  />
                  <Badge variant="outline">{{ step.command }}</Badge>
                  <ChevronRight class="size-4 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground" />
                </span>
              </NuxtLink>
              <div
                v-else
                class="flex cursor-not-allowed items-start gap-3 rounded-md border border-dashed border-border/60 bg-muted/10 p-3 text-muted-foreground/70"
                :title="`Zuerst Step ${index} abschließen`"
              >
                <span class="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted/60 text-xs font-medium">
                  {{ index + 1 }}
                </span>
                <div class="flex-1">
                  <p class="text-sm font-medium">{{ step.label }}</p>
                  <p class="text-xs">{{ step.summary }}</p>
                </div>
                <Lock class="mt-0.5 size-4 shrink-0" />
              </div>
            </template>
          </CardContent>
        </Card>

        <div class="grid gap-6 lg:grid-cols-2">
          <NotificationLogWidget
            :events="events ?? []"
            :loading="eventsLoading"
            @open-drawer="notificationDrawerOpen = true"
          />
          <InstalledExtensionsWidget :slug="slug" />
        </div>
      </div>
    </div>

    <NotificationDrawer
      v-model:open="notificationDrawerOpen"
      :events="events ?? []"
    />

    <ConfirmDialog
      v-model:open="deleteDialogOpen"
      :title="`Projekt '${project.title}' löschen?`"
      message="Dies entfernt das Projekt-Verzeichnis mit allen spec-kit-Artefakten und Source-Dateien sowie alle SpecOps-Metadaten."
      :details="`Betroffen: projects/${project.slug}/ und .specops/${project.slug}/`"
      confirm-label="Endgültig löschen"
      destructive
      :busy="deleting"
      @confirm="deleteProject"
    />
  </div>
</template>
