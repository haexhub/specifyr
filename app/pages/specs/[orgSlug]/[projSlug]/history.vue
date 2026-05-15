<script setup lang="ts">
import { ArrowLeft, Filter } from "lucide-vue-next";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/shadcn/card";
import ProjectShell from "~/components/projects/ProjectShell.vue";
import { resolveWorkflow, type Workflow } from "~/utils/workflows";

const route = useRoute();
const orgSlug = computed(() => route.params.orgSlug as string);
const projSlug = computed(() => route.params.projSlug as string);
const apiBase = computed(() => `/api/orgs/${orgSlug.value}/projects/${projSlug.value}`);
const routeBase = computed(() => `/specs/${orgSlug.value}/${projSlug.value}`);

interface EventRow {
  id: string;
  at: string;
  type: string;
  slug: string | null;
  role: string | null;
  task_path: string | null;
  parent_task_id: string | null;
  status: string | null;
  payload: Record<string, unknown> & {
    summary?: string;
    transcript?: string;
    task_title?: string;
  };
}

const { data: project } = await useFetch<{
  workflow?: string;
  workflowDefinition?: Workflow;
  title?: string;
  [k: string]: unknown;
}>(() => apiBase.value, {
  key: () => `project-${orgSlug.value}-${projSlug.value}`,
});

const workflow = computed(() =>
  resolveWorkflow(project.value?.workflow, project.value?.workflowDefinition ?? null),
);

const events = ref<EventRow[]>([]);
const loading = ref(false);
const errorMsg = ref<string | null>(null);
const limit = ref(200);
const typeFilter = ref<string>("all");
const roleFilter = ref<string>("all");

async function fetchEvents() {
  loading.value = true;
  errorMsg.value = null;
  try {
    const data = await $fetch<{ events: EventRow[] }>(
      `${apiBase.value}/company/events?limit=${limit.value}`,
    );
    events.value = data.events;
  } catch (err: unknown) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(fetchEvents);

const knownRoles = computed(() => {
  const set = new Set<string>();
  for (const e of events.value) if (e.role) set.add(e.role);
  return [...set].sort();
});

const knownTypes = computed(() => {
  const set = new Set<string>();
  for (const e of events.value) set.add(e.type);
  return [...set].sort();
});

const filtered = computed(() =>
  events.value.filter((e) => {
    if (typeFilter.value !== "all" && e.type !== typeFilter.value) return false;
    if (roleFilter.value !== "all" && e.role !== roleFilter.value) return false;
    return true;
  }),
);

function eventDotColor(type: string): string {
  if (type === "dispatch-started") return "text-blue-500";
  if (type === "dispatch-completed") return "text-green-500";
  if (type === "dispatch-failed") return "text-amber-500";
  if (type === "dispatch-error") return "text-red-500";
  if (type === "agent-stuck") return "text-red-600";
  return "text-muted-foreground";
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function shortPath(p: string | null): string {
  if (!p) return "";
  const parts = p.split("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
}
</script>

<template>
  <ProjectsProjectShell
    :org-slug="orgSlug"
    :proj-slug="projSlug"
    :project-title="project?.title"
    :workflow="workflow"
    :show-steps="false"
  >
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-lg font-semibold">{{ $t("history.title") }}</h1>
        <p class="text-xs text-muted-foreground">{{ $t("history.subtitle") }}</p>
      </div>
      <NuxtLink
        :to="`${routeBase}/runtime`"
        class="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted/40"
      >
        <ArrowLeft class="size-3.5" />
        {{ $t("history.backToRuntime") }}
      </NuxtLink>
    </header>

    <Card>
      <CardHeader>
        <div class="flex items-center gap-2">
          <Filter class="size-4 text-primary" />
          <CardTitle class="text-base">{{ $t("history.filtersTitle") }}</CardTitle>
        </div>
      </CardHeader>
      <CardContent class="flex flex-wrap items-end gap-3">
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">{{ $t("history.filterType") }}</span>
          <select
            v-model="typeFilter"
            class="rounded-md border border-border bg-background px-2 py-1 text-sm"
          >
            <option value="all">{{ $t("history.filterAll") }}</option>
            <option v-for="t in knownTypes" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">{{ $t("history.filterRole") }}</span>
          <select
            v-model="roleFilter"
            class="rounded-md border border-border bg-background px-2 py-1 text-sm"
          >
            <option value="all">{{ $t("history.filterAll") }}</option>
            <option v-for="r in knownRoles" :key="r" :value="r">{{ r }}</option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">{{ $t("history.filterLimit") }}</span>
          <select
            v-model.number="limit"
            class="rounded-md border border-border bg-background px-2 py-1 text-sm"
            @change="fetchEvents"
          >
            <option :value="50">50</option>
            <option :value="100">100</option>
            <option :value="200">200</option>
            <option :value="500">500</option>
          </select>
        </label>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted/40"
          :disabled="loading"
          @click="fetchEvents"
        >
          {{ loading ? "…" : $t("history.refresh") }}
        </button>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">
          {{ $t("history.eventsTitle", { shown: filtered.length, total: events.length }) }}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p v-if="errorMsg" class="text-sm text-red-600 dark:text-red-400">{{ errorMsg }}</p>
        <p v-else-if="!loading && filtered.length === 0" class="text-sm text-muted-foreground">
          {{ $t("history.empty") }}
        </p>
        <ul v-else class="space-y-2">
          <li
            v-for="e in filtered"
            :key="e.id"
            class="rounded-md border bg-muted/20 px-3 py-2 text-xs"
          >
            <div class="flex flex-wrap items-center gap-2">
              <span class="size-2 rounded-full bg-current" :class="eventDotColor(e.type)" />
              <span class="font-medium">{{ e.type }}</span>
              <span v-if="e.role" class="rounded bg-muted px-1.5 py-0.5">{{ e.role }}</span>
              <span class="ml-auto text-muted-foreground">{{ formatTime(e.at) }}</span>
            </div>
            <div v-if="e.payload?.task_title" class="mt-1 text-foreground">
              {{ e.payload.task_title }}
            </div>
            <div v-else-if="e.task_path" class="mt-1 text-muted-foreground">
              {{ shortPath(e.task_path) }}
            </div>
            <div
              v-if="e.payload?.summary"
              class="mt-1 font-mono text-[11px] text-muted-foreground"
            >
              {{ e.payload.summary }}
            </div>
            <details
              v-if="e.payload?.transcript"
              class="mt-1"
            >
              <summary class="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
                {{ $t("history.showTranscript") }}
              </summary>
              <pre class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[10px] text-muted-foreground">{{ e.payload.transcript }}</pre>
            </details>
          </li>
        </ul>
      </CardContent>
    </Card>
  </ProjectsProjectShell>
</template>
