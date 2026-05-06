<script setup lang="ts">
import ProjectListSidebar from "~/components/ProjectListSidebar.vue";
import type { ProjectListItem } from "~/lib/types";

const route = useRoute();
const { data: projects, refresh } = await useFetch<ProjectListItem[]>("/api/projects", {
  default: () => [],
  key: "projects-list"
});

provide("refreshProjects", refresh);

// Inside a project, the ProjectStepSidebar already provides project context.
// We keep the global sidebar but collapse it to its icon-rail (compact)
// mode so Settings/Extensions/Project-list stay one click away without
// crowding the workspace.
const compactGlobalSidebar = computed(() => route.path.startsWith("/specs/"));
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <div class="flex min-h-screen">
      <ProjectListSidebar :projects="projects ?? []" :compact="compactGlobalSidebar" />
      <main class="min-h-screen flex-1 overflow-x-hidden">
        <slot />
      </main>
    </div>
  </div>
</template>
