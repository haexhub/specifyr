<script setup lang="ts">
// ProjectShell — shared layout for any /specs/<slug>/* view.
//
// Structure:
//   [sidebar]   |  [tabs-row — fixed top, never scrolls]
//               |  [content-row — scrolls vertically]
//
// The tabs-row lives in the chrome layer so its position is identical across
// every view that uses ProjectShell. Page-specific content (headers, panes,
// action buttons) stays in the default slot and may grow/shrink freely
// without nudging the tabs.
//
// Slots:
//   sidebar — view-specific sidebar content (rendered below the always-visible
//             "Alle Projekte" + project title block in ProjectStepSidebar).
//   default — page body. Caller wraps in its own header / cards / etc.

import { Menu, PanelLeft } from "lucide-vue-next";
import ProjectStepSidebar from "~/components/projects/ProjectStepSidebar.vue";
import ProjectViewTabs from "~/components/projects/ProjectViewTabs.vue";
import type { Workflow } from "~/utils/workflows";

withDefaults(
  defineProps<{
    orgSlug: string;
    projSlug: string;
    projectTitle?: string;
    workflow?: Workflow | null;
    showSteps?: boolean;
  }>(),
  { showSteps: true },
);

const route = useRoute();
const stepSidebar = provideProjectStepSidebar();
const projectListSidebar = useProjectListSidebar();

// Close mobile drawers on navigation so they don't linger after tab switches.
watch(() => route.path, () => stepSidebar.close());
</script>

<template>
  <div class="flex h-full">
    <ProjectsProjectStepSidebar
      :org-slug="orgSlug"
      :proj-slug="projSlug"
      :project-title="projectTitle"
      :workflow="workflow ?? undefined"
      :show-steps="showSteps"
      :mobile-open="stepSidebar.open.value"
      @close="stepSidebar.close()"
    >
      <slot name="sidebar" />
    </ProjectsProjectStepSidebar>

    <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <!-- Tabs row: fixed position at top of content area. Never scrolls.
           No max-width — tabs sit at the same left padding as the content
           below, so content+tabs share an alignment edge regardless of
           viewport width. h-15 mirrors the sidebar header heights so the
           border-b dividers line up horizontally across all columns.
           On mobile we prepend two toggle buttons: global project list +
           step sidebar. -->
      <div class="flex h-15 shrink-0 items-center gap-1 border-b border-border bg-background/50 px-3 lg:px-10">
        <button
          v-if="projectListSidebar"
          type="button"
          class="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground lg:hidden"
          :aria-label="$t('sidebar.openMenu')"
          @click="projectListSidebar.toggle()"
        >
          <Menu class="size-5" />
        </button>
        <button
          type="button"
          class="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground lg:hidden"
          :aria-label="$t('sidebar.openStepMenu')"
          @click="stepSidebar.toggle()"
        >
          <PanelLeft class="size-5" />
        </button>
        <div class="min-w-0 flex-1 overflow-x-auto">
          <ProjectsProjectViewTabs :org-slug="orgSlug" :proj-slug="projSlug" />
        </div>
      </div>

      <!-- Page body: scrolls independently. Full-width within the padding;
           page content (cards, panes, grids) decides its own line length
           via internal layout (e.g. lg:grid-cols-2). -->
      <div class="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-10">
        <div class="space-y-6">
          <slot />
        </div>
      </div>
    </div>
  </div>
</template>
