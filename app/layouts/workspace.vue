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

const compactGlobalSidebar = computed(() => route.path.startsWith("/specs/"));

const projectListSidebar = provideProjectListSidebar();
watch(() => route.path, () => projectListSidebar.close());

// Pages that render ProjectShell already host the mobile toggle in their own
// chrome (so the sidebar+tabs row stays a single header). On other workspace
// pages (admin, invites, onboarding, /, ...) we render a thin mobile bar.
const insideProjectShell = computed(() => /^\/specs\/[^/]+(\/|$)/.test(route.path));
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
        <header
          v-if="!insideProjectShell"
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
          <slot />
        </div>
      </main>
    </div>
  </div>
</template>
