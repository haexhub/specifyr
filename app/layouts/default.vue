<script setup lang="ts">
import ProjectListSidebar from "~/components/ProjectListSidebar.vue";
import type { ProjectListItem } from "~/lib/types";

const route = useRoute();
const { data: projects, refresh } = await useFetch<ProjectListItem[]>("/api/projects", {
  default: () => [],
  key: "projects-list"
});

provide("refreshProjects", refresh);

// Inside a project, the ProjectStepSidebar already provides project context,
// so we drop the global project list entirely to give the workspace more room.
const hideGlobalSidebar = computed(() => route.path.startsWith("/specs/"));
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <div class="flex min-h-screen">
      <ProjectListSidebar v-if="!hideGlobalSidebar" :projects="projects ?? []" />
      <main class="min-h-screen flex-1 overflow-x-hidden">
        <slot />
      </main>
    </div>
  </div>
</template>
