<script setup lang="ts">
import ProjectListSidebar from "~/components/layout/ProjectListSidebar.vue";
import type { ProjectListItem } from "~/types/types";

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
  <div class="h-dvh bg-background text-foreground">
    <div class="flex h-full">
      <LayoutProjectListSidebar :projects="projects ?? []" :compact="compactGlobalSidebar" />
      <main class="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div class="mx-auto w-full max-w-4xl p-6 lg:p-10">
          <slot />
        </div>
      </main>
    </div>
  </div>
</template>
