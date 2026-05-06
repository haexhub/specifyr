<script setup lang="ts">
import { LogOut, Plus, FolderOpen, Puzzle, Settings, Trash2 } from "lucide-vue-next";
import ProjectCreateDialog from "~/components/ProjectCreateDialog.vue";
import ConfirmDialog from "~/components/ConfirmDialog.vue";
import type { ProjectListItem } from "~/lib/types";

const props = defineProps<{
  projects: ProjectListItem[];
  compact?: boolean;
}>();

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const dialogOpen = ref(false);
const deleteTarget = ref<ProjectListItem | null>(null);
const deleting = ref(false);
const refreshProjects = inject<() => Promise<void>>("refreshProjects", async () => {});

const { me, logoutUrl } = useMe();

const activeSlug = computed(() => {
  if (typeof route.params.slug === "string") {
    return route.params.slug;
  }
  return null;
});

function formatRelative(iso?: string): string {
  if (!iso) return "";
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function projectInitial(title: string): string {
  return title.trim().charAt(0).toUpperCase() || "?";
}

async function handleCreated() {
  dialogOpen.value = false;
  await refreshProjects();
}

function openDeleteDialog(project: ProjectListItem, event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  deleteTarget.value = project;
}

async function confirmDelete() {
  const target = deleteTarget.value;
  if (!target || deleting.value) return;
  deleting.value = true;
  try {
    await $fetch(`/api/projects/${target.slug}`, { method: "DELETE" });
    deleteTarget.value = null;
    await refreshProjects();
    if (activeSlug.value === target.slug) {
      await router.push("/");
    }
  } catch (error) {
    alert(error instanceof Error ? error.message : t("common.error"));
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <aside
    class="flex h-screen flex-col border-r border-border bg-muted/30 transition-all"
    :class="compact ? 'w-14' : 'w-[280px]'"
  >
    <div class="flex items-center justify-between gap-1 px-2 pb-3 pt-5" :class="!compact && 'px-4'">
      <NuxtLink
        to="/"
        class="min-w-0"
        :class="compact ? 'sr-only' : ''"
      >
        <SpecifyrLogo />
      </NuxtLink>
      <NuxtLink
        v-if="compact"
        to="/"
        class="mx-auto inline-flex size-8 items-center justify-center rounded-md text-primary"
        :class="route.path === '/' ? 'bg-primary/15' : 'hover:bg-accent'"
        :title="$t('sidebar.homepage')"
      >
        <SpecifyrLogo compact :show-text="false" />
      </NuxtLink>
      <button
        v-if="!compact"
        type="button"
        class="inline-flex size-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"
        :title="$t('sidebar.newProject')"
        @click="dialogOpen = true"
      >
        <Plus class="size-4" />
      </button>
    </div>

    <!-- Compact: icon rail with small +/button -->
    <nav v-if="compact" class="flex-1 space-y-1 overflow-y-auto px-2">
      <button
        type="button"
        class="inline-flex size-10 w-full items-center justify-center rounded-md border border-dashed border-border text-muted-foreground transition hover:border-primary/50 hover:bg-accent hover:text-foreground"
        :title="$t('sidebar.newProject')"
        @click="dialogOpen = true"
      >
        <Plus class="size-4" />
      </button>
      <NuxtLink
        v-for="project in projects"
        :key="project.slug"
        :to="`/specs/${project.slug}`"
        class="group relative flex size-10 w-full items-center justify-center rounded-md text-xs font-semibold uppercase tracking-wide transition"
        :class="project.slug === activeSlug ? 'bg-primary/90 text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground'"
        :title="project.title"
      >
        {{ projectInitial(project.title) }}
        <button
          type="button"
          class="absolute -right-1 -top-1 hidden size-4 items-center justify-center rounded-full border border-border bg-background text-destructive opacity-0 transition group-hover:flex group-hover:opacity-100 hover:bg-destructive hover:text-destructive-foreground"
          :title="t('sidebar.deleteProjectTitle', { title: project.title })"
          @click="openDeleteDialog(project, $event)"
        >
          <Trash2 class="size-2.5" />
        </button>
      </NuxtLink>
    </nav>

    <!-- Expanded: full list -->
    <nav v-else class="flex-1 overflow-y-auto px-2">
      <ul v-if="projects.length" class="flex flex-col gap-0.5">
        <li v-for="project in projects" :key="project.slug" class="group relative">
          <NuxtLink
            :to="`/specs/${project.slug}`"
            class="flex items-center justify-between gap-2 rounded-md px-2 py-2 pr-8 text-sm transition"
            :class="project.slug === activeSlug ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'"
          >
            <span class="flex min-w-0 items-center gap-2">
              <FolderOpen class="size-4 shrink-0 opacity-70" />
              <span class="truncate">{{ project.title }}</span>
            </span>
            <span class="text-[10px] uppercase tracking-wider opacity-60">
              {{ formatRelative(project.updatedAt) }}
            </span>
          </NuxtLink>
          <button
            type="button"
            class="absolute right-1.5 top-1/2 hidden size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition group-hover:flex group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
            :title="$t('sidebar.deleteProject')"
            @click="openDeleteDialog(project, $event)"
          >
            <Trash2 class="size-3.5" />
          </button>
        </li>
      </ul>
      <p v-else class="px-3 py-6 text-xs text-muted-foreground">
        {{ $t("sidebar.noProjects") }}
      </p>
    </nav>

    <div class="space-y-1 border-t border-border py-3" :class="compact ? 'px-2' : 'px-2'">
      <NuxtLink
        to="/extensions"
        class="flex items-center gap-2 rounded-md text-sm transition"
        :class="[
          route.path === '/extensions' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
          compact ? 'size-10 justify-center p-0' : 'px-2 py-2'
        ]"
        :title="compact ? $t('sidebar.extensions') : undefined"
      >
        <Puzzle class="size-4 opacity-70" />
        <span v-if="!compact">{{ $t("sidebar.extensions") }}</span>
      </NuxtLink>
      <NuxtLink
        to="/settings"
        class="flex items-center gap-2 rounded-md text-sm transition"
        :class="[
          route.path.startsWith('/settings') ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
          compact ? 'size-10 justify-center p-0' : 'px-2 py-2'
        ]"
        :title="compact ? 'Settings' : undefined"
      >
        <Settings class="size-4 opacity-70" />
        <span v-if="!compact">Settings</span>
      </NuxtLink>

      <!-- User identity + logout. Hidden when no user resolved
           (unauth) or no logoutUrl configured (dev w/o IDP). -->
      <a
        v-if="me && logoutUrl !== '#'"
        :href="logoutUrl"
        class="flex items-center gap-2 rounded-md text-sm transition text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        :class="compact ? 'size-10 justify-center p-0' : 'px-2 py-2'"
        :title="compact ? `Logout (${me.email})` : 'Logout'"
      >
        <LogOut class="size-4 opacity-70" />
        <span v-if="!compact" class="flex min-w-0 flex-col items-start leading-tight">
          <span class="truncate text-xs">Logout</span>
          <span class="truncate text-[10px] opacity-60">{{ me.email }}</span>
        </span>
      </a>
    </div>

    <ProjectCreateDialog v-model:open="dialogOpen" @created="handleCreated" />

    <ConfirmDialog
      :open="deleteTarget !== null"
      :title="deleteTarget ? $t('sidebar.deleteProjectTitle', { title: deleteTarget.title }) : ''"
      :message="$t('sidebar.deleteProjectMessage')"
      :details="deleteTarget ? $t('sidebar.deleteProjectDetails', { slug: deleteTarget.slug }) : ''"
      :confirm-label="$t('specIndex.deleteConfirm')"
      destructive
      :busy="deleting"
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />
  </aside>
</template>
