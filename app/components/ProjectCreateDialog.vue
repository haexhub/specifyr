<script setup lang="ts">
import { X } from "lucide-vue-next";
import { Button } from "~/components/ui/button";
import { DEFAULT_WORKFLOW_ID, type WorkflowSummary } from "~/lib/workflows";
import type { ProjectListItem } from "~/lib/types";

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  created: [project: ProjectListItem];
}>();

const title = ref("");
const description = ref("");
const submitting = ref(false);
const errorMessage = ref("");
const selectedWorkflow = ref<string>(DEFAULT_WORKFLOW_ID);
const workflows = ref<WorkflowSummary[]>([]);
const workflowsLoading = ref(false);

const standardExtensions = ref<string[]>([]);
const selectedExtensions = ref<Set<string>>(new Set());
const extensionsLoading = ref(false);

async function refreshWorkflows() {
  workflowsLoading.value = true;
  try {
    workflows.value = await $fetch<WorkflowSummary[]>("/api/workflows/catalog");
  } catch {
    workflows.value = [];
  } finally {
    workflowsLoading.value = false;
  }
}

const selectedWorkflowSummary = computed(() =>
  workflows.value.find((w) => w.id === selectedWorkflow.value) ?? null
);

async function refreshStandardExtensions() {
  extensionsLoading.value = true;
  try {
    const res = await $fetch<{ extensions: string[] }>("/api/config/standard-extensions");
    standardExtensions.value = res.extensions ?? [];
    selectedExtensions.value = new Set(standardExtensions.value);
  } catch {
    standardExtensions.value = [];
    selectedExtensions.value = new Set();
  } finally {
    extensionsLoading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      title.value = "";
      description.value = "";
      errorMessage.value = "";
      selectedWorkflow.value = DEFAULT_WORKFLOW_ID;
      refreshStandardExtensions();
      refreshWorkflows();
    }
  }
);

function toggleExtension(slug: string) {
  const next = new Set(selectedExtensions.value);
  if (next.has(slug)) next.delete(slug);
  else next.add(slug);
  selectedExtensions.value = next;
}

function close() {
  if (submitting.value) return;
  emit("update:open", false);
}

async function submit() {
  const trimmed = title.value.trim();
  if (!trimmed || submitting.value) return;

  submitting.value = true;
  errorMessage.value = "";

  try {
    // Workflow-extensions must be installed for the workflow to surface on the project side.
    // Silently union the chosen workflow's extension slug into the install list so the user
    // doesn't have to remember to check the box.
    const extensionsToInstall = new Set(selectedExtensions.value);
    if (selectedWorkflowSummary.value?.extensionSlug) {
      extensionsToInstall.add(selectedWorkflowSummary.value.extensionSlug);
    }

    const created = await $fetch<ProjectListItem>("/api/projects", {
      method: "POST",
      body: {
        title: trimmed,
        description: description.value.trim(),
        extensions: [...extensionsToInstall],
        workflow: selectedWorkflow.value
      }
    });
    emit("created", created);
    await navigateTo(`/specs/${created.slug}`);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Projekt konnte nicht erstellt werden.";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm"
      @click.self="close"
    >
      <div class="relative w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-xl">
        <button
          type="button"
          class="absolute right-4 top-4 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
          @click="close"
        >
          <X class="size-4" />
        </button>

        <h2 class="text-lg font-semibold">Neues Projekt</h2>

        <form class="mt-5 space-y-4" @submit.prevent="submit">
          <div class="space-y-1.5">
            <label for="project-title" class="text-sm font-medium">Name</label>
            <input
              id="project-title"
              v-model="title"
              autofocus
              class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background transition focus:ring-2 focus:ring-ring focus:ring-offset-2"
              placeholder="z.B. Customer Portal"
            />
          </div>

          <div class="space-y-1.5">
            <label for="project-description" class="text-sm font-medium">
              Beschreibung <span class="text-xs font-normal text-muted-foreground">(optional)</span>
            </label>
            <textarea
              id="project-description"
              v-model="description"
              rows="3"
              class="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background transition focus:ring-2 focus:ring-ring focus:ring-offset-2"
              placeholder="Worum geht es?"
            />
          </div>

          <div class="space-y-1.5">
            <label for="project-workflow" class="text-sm font-medium">Workflow</label>
            <select
              id="project-workflow"
              v-model="selectedWorkflow"
              :disabled="workflowsLoading"
              class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background transition focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-60"
            >
              <option v-for="wf in workflows" :key="wf.id" :value="wf.id">
                {{ wf.label }}
              </option>
            </select>
            <p class="text-[11px] text-muted-foreground">
              {{ selectedWorkflowSummary?.description }}
            </p>
            <p
              v-if="selectedWorkflowSummary?.extensionSlug"
              class="text-[11px] text-muted-foreground"
            >
              Extension <code class="font-mono">{{ selectedWorkflowSummary.extensionSlug }}</code>
              wird automatisch mitinstalliert.
            </p>
          </div>

          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <p class="text-sm font-medium">Standard-Extensions</p>
              <NuxtLink
                to="/extensions"
                class="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                @click="close"
              >
                Liste verwalten →
              </NuxtLink>
            </div>

            <div v-if="extensionsLoading" class="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
              Lade Liste…
            </div>
            <div
              v-else-if="!standardExtensions.length"
              class="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"
            >
              Keine Standard-Extensions konfiguriert. Du kannst sie unter
              <NuxtLink to="/extensions" class="underline" @click="close">/extensions</NuxtLink> hinzufügen.
            </div>
            <ul v-else class="space-y-1">
              <li v-for="slug in standardExtensions" :key="slug">
                <label class="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm transition hover:bg-accent/50">
                  <input
                    type="checkbox"
                    class="size-4 rounded border-input"
                    :checked="selectedExtensions.has(slug)"
                    @change="toggleExtension(slug)"
                  />
                  <code class="flex-1 truncate font-mono text-xs">{{ slug }}</code>
                </label>
              </li>
            </ul>
          </div>

          <p v-if="errorMessage" class="text-sm text-destructive">{{ errorMessage }}</p>

          <div class="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" :disabled="submitting" @click="close">
              Abbrechen
            </Button>
            <Button type="submit" :disabled="submitting || !title.trim()">
              {{ submitting ? "Erstelle…" : "Erstellen" }}
            </Button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>
