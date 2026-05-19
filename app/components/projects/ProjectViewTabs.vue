<script setup lang="ts">
// Speckit/Runtime/Secrets tab navigation in the content header.
//
// Why NuxtLink-based tabs and not a stateful Tabs component:
//   The views are real routes ("/specs/<orgSlug>/<projSlug>" vs ".../runtime"),
//   so we get browser-history, deep-linking and middle-click-new-tab for free.
//   A reka-ui <Tabs> would be a stateful client-only widget that re-implements
//   half of that.

import { FileText, Activity, KeyRound, GitBranch, MessageSquareCode } from "lucide-vue-next";

const props = defineProps<{ orgSlug: string; projSlug: string }>();
const route = useRoute();

const base = computed(() => `/specs/${props.orgSlug}/${props.projSlug}`);
const isRuntime = computed(() => route.path.startsWith(`${base.value}/runtime`));
const isSecrets = computed(() => route.path.startsWith(`${base.value}/secrets`));
const isRepository = computed(() => route.path.startsWith(`${base.value}/repository`));
const isChat = computed(() => route.path.startsWith(`${base.value}/chat`));
const isSpeckit = computed(
  () => !isRuntime.value && !isSecrets.value && !isRepository.value && !isChat.value,
);
</script>

<template>
  <nav class="inline-flex items-center gap-1 rounded-lg border bg-muted/40 p-1">
    <NuxtLink
      :to="base"
      class="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition"
      :class="isSpeckit
        ? 'bg-background font-medium text-foreground shadow-sm'
        : 'text-muted-foreground hover:text-foreground'"
    >
      <FileText class="size-3.5" />
      Speckit
    </NuxtLink>
    <NuxtLink
      :to="`${base}/chat`"
      class="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition"
      :class="isChat
        ? 'bg-background font-medium text-foreground shadow-sm'
        : 'text-muted-foreground hover:text-foreground'"
    >
      <MessageSquareCode class="size-3.5" />
      Chat
    </NuxtLink>
    <NuxtLink
      :to="`${base}/runtime`"
      class="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition"
      :class="isRuntime
        ? 'bg-background font-medium text-foreground shadow-sm'
        : 'text-muted-foreground hover:text-foreground'"
    >
      <Activity class="size-3.5" />
      Runtime
    </NuxtLink>
    <NuxtLink
      :to="`${base}/secrets`"
      class="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition"
      :class="isSecrets
        ? 'bg-background font-medium text-foreground shadow-sm'
        : 'text-muted-foreground hover:text-foreground'"
    >
      <KeyRound class="size-3.5" />
      Secrets
    </NuxtLink>
    <NuxtLink
      :to="`${base}/repository`"
      class="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition"
      :class="isRepository
        ? 'bg-background font-medium text-foreground shadow-sm'
        : 'text-muted-foreground hover:text-foreground'"
    >
      <GitBranch class="size-3.5" />
      Repository
    </NuxtLink>
  </nav>
</template>
