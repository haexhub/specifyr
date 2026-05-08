<script setup lang="ts">
import ProjectListSidebar from "~/components/ProjectListSidebar.vue";
import type { ProjectListItem } from "~/lib/types";

const route = useRoute();
const { data: projects, refresh } = await useFetch<ProjectListItem[]>("/api/projects", {
  default: () => [],
  key: "projects-list"
});

provide("refreshProjects", refresh);

const compactGlobalSidebar = computed(() => route.path.startsWith("/specs/"));
</script>

<template>
  <div class="h-dvh bg-background text-foreground">
    <div class="flex h-full">
      <ProjectListSidebar :projects="projects ?? []" :compact="compactGlobalSidebar" />
      <main class="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        <slot />
      </main>
    </div>
  </div>
</template>
