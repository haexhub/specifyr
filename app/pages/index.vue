<script setup lang="ts">
definePageMeta({ layout: "workspace" });

import { Plus, FolderOpen } from "lucide-vue-next";
import { Button } from "~/components/shadcn/button";
import ProjectCreateDialog from "~/components/ProjectCreateDialog.vue";
import type { ProjectListItem } from "~/lib/types";

const dialogOpen = ref(false);
const refreshProjects = inject<() => Promise<void>>("refreshProjects", async () => {});

const { data: projects } = await useFetch<ProjectListItem[]>("/api/projects", {
  default: () => [],
  key: "projects-list"
});

const firstProject = computed<ProjectListItem | null>(() => {
  const list = projects.value ?? [];
  return list.length > 0 ? list[0]! : null;
});

async function handleCreated() {
  dialogOpen.value = false;
  await refreshProjects();
}
</script>

<template>
  <div class="flex h-full items-center justify-center px-8 py-12">
    <div class="w-full max-w-xl text-center">
      <div class="mx-auto mb-6 inline-flex size-24 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <SpecifyrLogo size="hero" :show-text="false" />
      </div>

      <h1 class="text-3xl font-semibold tracking-tight">specifyr</h1>
      <p class="mt-3 text-muted-foreground">
        {{ $t("index.subtitle") }}
      </p>

      <div class="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Button size="lg" @click="dialogOpen = true">
          <Plus class="mr-2 size-4" /> {{ $t("index.newProject") }}
        </Button>
        <NuxtLink v-if="firstProject" :to="`/specs/${firstProject.slug}`">
          <Button size="lg" variant="outline">
            <FolderOpen class="mr-2 size-4" />
            {{ $t("index.openLast") }}
          </Button>
        </NuxtLink>
      </div>

      <p v-if="!firstProject" class="mt-10 text-xs text-muted-foreground">
        {{ $t("index.noProjects") }}
      </p>
    </div>

    <ProjectCreateDialog v-model:open="dialogOpen" @created="handleCreated" />
  </div>
</template>
