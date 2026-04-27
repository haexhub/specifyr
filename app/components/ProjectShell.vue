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

import ProjectStepSidebar from "~/components/ProjectStepSidebar.vue";
import ProjectViewTabs from "~/components/ProjectViewTabs.vue";
import type { Workflow } from "~/lib/workflows";

defineProps<{
  slug: string;
  projectTitle?: string;
  workflow?: Workflow | null;
  showSteps?: boolean;
}>();
</script>

<template>
  <div class="flex h-screen">
    <ProjectStepSidebar
      :slug="slug"
      :project-title="projectTitle"
      :workflow="workflow ?? undefined"
      :show-steps="showSteps ?? true"
    >
      <slot name="sidebar" />
    </ProjectStepSidebar>

    <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <!-- Tabs row: fixed position at top of content area. Never scrolls. -->
      <div class="shrink-0 border-b border-border bg-background/50 px-6 py-3 lg:px-10">
        <div class="mx-auto max-w-5xl">
          <ProjectViewTabs :slug="slug" />
        </div>
      </div>

      <!-- Page body: scrolls independently. -->
      <div class="flex-1 overflow-y-auto p-6 lg:p-10">
        <div class="mx-auto max-w-5xl space-y-6">
          <slot />
        </div>
      </div>
    </div>
  </div>
</template>
