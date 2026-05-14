<script setup lang="ts">
import { Menu } from "lucide-vue-next";
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

const projectListSidebar = provideProjectListSidebar();
// Close the mobile drawer when route changes so it doesn't linger after navigation.
watch(() => route.path, () => projectListSidebar.close());
</script>

<template>
  <div class="h-dvh bg-background text-foreground">
    <div class="flex h-full">
      <LayoutProjectListSidebar
        :projects="projects ?? []"
        :compact="compactGlobalSidebar"
        :mobile-open="projectListSidebar.open.value"
        @close="projectListSidebar.close()"
      />
      <main class="flex min-w-0 flex-1 flex-col">
        <!-- Mobile-only top bar with hamburger. Hidden on lg+ where the
             sidebar is always visible. -->
        <header
          class="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 bg-background/80 px-3 lg:hidden"
        >
          <button
            type="button"
            class="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
            :aria-label="$t('sidebar.openMenu')"
            @click="projectListSidebar.toggle()"
          >
            <Menu class="size-5" />
          </button>
          <CommonSpecifyrLogo />
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div class="mx-auto w-full max-w-4xl p-6 lg:p-10">
            <slot />
          </div>
        </div>
      </main>
    </div>
  </div>
</template>
