<script setup lang="ts">
import { GitBranch, CircleAlert, Check } from "lucide-vue-next";

interface RepositoryStatus {
  configured: boolean;
  lastPushedAt?: string | null;
}

const props = defineProps<{ slug: string }>();

const { data, refresh, status } = await useFetch<RepositoryStatus>(
  () => `/api/projects/${props.slug}/repository`,
  { key: () => `repo-status-${props.slug}`, default: () => ({ configured: false }) },
);

let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(() => refresh(), 30_000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});

const lastPushedLabel = computed(() => {
  const iso = data.value?.lastPushedAt;
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown";
  const diff = Date.now() - d.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ago`;
  return d.toLocaleDateString();
});

const failed = computed(() => status.value === "error");
</script>

<template>
  <NuxtLink
    v-if="data?.configured"
    :to="`/specs/${slug}/repository`"
    class="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition hover:bg-muted/50"
    :class="failed ? 'border-destructive/40 text-destructive' : 'border-border text-muted-foreground'"
  >
    <CircleAlert v-if="failed" class="size-3" />
    <Check v-else class="size-3 text-emerald-600 dark:text-emerald-400" />
    <span class="font-medium">Synced</span>
    <span class="text-muted-foreground">{{ lastPushedLabel }}</span>
  </NuxtLink>
  <NuxtLink
    v-else
    :to="`/specs/${slug}/repository`"
    class="inline-flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground transition hover:bg-muted/50"
  >
    <GitBranch class="size-3" />
    <span>Connect remote</span>
  </NuxtLink>
</template>
