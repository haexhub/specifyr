<script setup lang="ts">
import { ArrowLeft, Check, AlertTriangle, Loader2, Lock } from "lucide-vue-next";
import { isStepUnlocked, type StepId, type StepStatus } from "~/lib/steps";
import { resolveWorkflow, type Workflow } from "~/lib/workflows";
import type { StepState } from "~/lib/types";

const props = defineProps<{
  slug: string;
  projectTitle?: string;
  activeStepId?: StepId;
  // Parent passes the full workflow definition (from the project snapshot's workflowDefinition).
  // Falls back to spec-kit if missing so the sidebar stays usable before the snapshot lands.
  workflow?: Workflow | null;
}>();

const workflow = computed(() => resolveWorkflow(props.workflow?.id, props.workflow ?? null));
const steps = computed(() => workflow.value.steps);

// Fetch step states so we can show status badges + gate downstream steps.
const { data: stepStates } = await useFetch<StepState[]>(() => `/api/projects/${props.slug}/steps`, {
  default: () => [],
  key: () => `steps-${props.slug}`
});

const statusMap = computed(() => {
  const map: Record<StepId, StepStatus | undefined> = {};
  for (const step of steps.value) map[step.id] = undefined;
  for (const s of stepStates.value ?? []) map[s.id] = s.status;
  return map;
});

function stateFor(id: StepId) {
  return stepStates.value?.find((s) => s.id === id);
}

function unlocked(id: StepId): boolean {
  return isStepUnlocked(id, statusMap.value, steps.value);
}

function stepRoute(step: { id: StepId; isRun?: boolean }) {
  // Runner-style steps (the last execution step of a workflow) get a dedicated /run route.
  if (step.isRun) return `/specs/${props.slug}/run`;
  return `/specs/${props.slug}/steps/${step.id}`;
}
</script>

<template>
  <aside class="flex h-screen w-[260px] shrink-0 flex-col border-r border-border bg-muted/20">
    <div class="border-b border-border/60 px-4 py-3">
      <NuxtLink
        to="/"
        class="inline-flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
      >
        <ArrowLeft class="size-3" />
        Alle Projekte
      </NuxtLink>
      <NuxtLink
        :to="`/specs/${slug}`"
        class="mt-1.5 block truncate text-sm font-semibold tracking-tight transition hover:text-primary"
        :title="projectTitle ?? slug"
      >
        {{ projectTitle ?? slug }}
      </NuxtLink>
    </div>

    <div class="flex-1 overflow-y-auto">
      <slot />
    </div>

    <div class="border-t border-border/60 p-2">
      <p class="px-2 pb-1.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Steps
      </p>
      <p v-if="workflow.source === 'extension'" class="px-2 pb-1 text-[10px] text-muted-foreground">
        {{ workflow.label }}
      </p>
      <ol class="flex flex-col gap-0.5">
        <li v-for="(step, index) in steps" :key="step.id">
          <NuxtLink
            v-if="unlocked(step.id)"
            :to="stepRoute(step)"
            class="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition"
            :class="step.id === activeStepId
              ? 'bg-accent text-accent-foreground font-medium'
              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'"
          >
            <span class="flex min-w-0 items-center gap-2">
              <span
                class="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
                :class="step.id === activeStepId ? 'bg-primary text-primary-foreground' : 'bg-muted'"
              >
                {{ index + 1 }}
              </span>
              <span class="truncate">{{ step.label }}</span>
            </span>
            <span class="shrink-0">
              <Check
                v-if="stateFor(step.id)?.status === 'complete'"
                class="size-3.5 text-emerald-600"
                title="abgeschlossen"
              />
              <Loader2
                v-else-if="stateFor(step.id)?.status === 'in_progress'"
                class="size-3.5 animate-spin text-primary"
                title="in Arbeit"
              />
              <AlertTriangle
                v-else-if="stateFor(step.id)?.status === 'stale'"
                class="size-3.5 text-amber-500"
                title="veraltet"
              />
            </span>
          </NuxtLink>
          <div
            v-else
            class="flex cursor-not-allowed items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground/60"
            :title="`Bitte zuerst Step ${index} abschließen`"
          >
            <span class="flex min-w-0 items-center gap-2">
              <span
                class="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted/60 text-[10px] font-semibold"
              >
                {{ index + 1 }}
              </span>
              <span class="truncate">{{ step.label }}</span>
            </span>
            <Lock class="size-3.5 shrink-0 text-muted-foreground/60" />
          </div>
        </li>
      </ol>
    </div>
  </aside>
</template>
