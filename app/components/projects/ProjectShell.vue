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
//
// Why not a Nuxt layout file:
//   We want both pages to opt-in explicitly and keep the freedom to NOT use
//   the shell on routes that need a different chrome (e.g. step detail with
//   its own back-button pattern). A component is more flexible than a layout.

import ProjectStepSidebar from "~/components/projects/ProjectStepSidebar.vue";
import ProjectViewTabs from "~/components/projects/ProjectViewTabs.vue";
import type { Workflow } from "~/utils/workflows";

defineProps<{
  orgSlug: string;
  projSlug: string;
  projectTitle?: string;
  workflow?: Workflow | null;
  showSteps?: boolean;
}>();
</script>

<template>
  <div class="flex h-screen">
    <ProjectsProjectStepSidebar
      :org-slug="orgSlug"
      :proj-slug="projSlug"
      :project-title="projectTitle"
      :workflow="workflow ?? undefined"
      :show-steps="showSteps ?? true"
    >
      <slot name="sidebar" />
    </ProjectsProjectStepSidebar>

    <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <!-- Tabs row: fixed position at top of content area. Never scrolls.
           No max-width — tabs sit at the same left padding as the content
           below, so content+tabs share an alignment edge regardless of
           viewport width. h-15 mirrors the sidebar header heights so the
           border-b dividers line up horizontally across all columns. -->
      <div class="flex h-15 shrink-0 items-center border-b border-border bg-background/50 px-6 lg:px-10">
        <ProjectsProjectViewTabs :org-slug="orgSlug" :proj-slug="projSlug" />
      </div>

      <!-- Page body: scrolls independently. Full-width within the padding;
           page content (cards, panes, grids) decides its own line length
           via internal layout (e.g. lg:grid-cols-2). -->
      <div class="flex-1 overflow-y-auto p-6 lg:p-10">
        <div class="space-y-6">
          <slot />
        </div>
      </div>
    </div>
  </div>
</template>
