<script setup lang="ts">
// Speckit/Runtime/Secrets tab navigation in the content header.
//
// Why NuxtLink-based tabs and not a stateful Tabs component:
//   The two views are real routes ("/specs/<slug>" vs "/specs/<slug>/runtime"),
//   so we get browser-history, deep-linking and middle-click-new-tab for free.
//   A reka-ui <Tabs> would be a stateful client-only widget that re-implements
//   half of that.
//
// Active state: any path under /specs/<slug>/(steps|run|"")  → Speckit;
//               /specs/<slug>/runtime                        → Runtime;
//               /specs/<slug>/secrets                        → Secrets.

import { FileText, Activity, KeyRound } from "lucide-vue-next";

const props = defineProps<{ slug: string }>();
const route = useRoute();

const isRuntime = computed(() => route.path.startsWith(`/specs/${props.slug}/runtime`));
const isSecrets = computed(() => route.path.startsWith(`/specs/${props.slug}/secrets`));
const isSpeckit = computed(() => !isRuntime.value && !isSecrets.value);
</script>

<template>
  <nav class="inline-flex items-center gap-1 rounded-lg border bg-muted/40 p-1">
    <NuxtLink
      :to="`/specs/${slug}`"
      class="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition"
      :class="isSpeckit
        ? 'bg-background font-medium text-foreground shadow-sm'
        : 'text-muted-foreground hover:text-foreground'"
    >
      <FileText class="size-3.5" />
      Speckit
    </NuxtLink>
    <NuxtLink
      :to="`/specs/${slug}/runtime`"
      class="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition"
      :class="isRuntime
        ? 'bg-background font-medium text-foreground shadow-sm'
        : 'text-muted-foreground hover:text-foreground'"
    >
      <Activity class="size-3.5" />
      Runtime
    </NuxtLink>
    <NuxtLink
      :to="`/specs/${slug}/secrets`"
      class="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition"
      :class="isSecrets
        ? 'bg-background font-medium text-foreground shadow-sm'
        : 'text-muted-foreground hover:text-foreground'"
    >
      <KeyRound class="size-3.5" />
      Secrets
    </NuxtLink>
  </nav>
</template>
