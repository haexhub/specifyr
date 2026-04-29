<script setup lang="ts">
defineProps<{
  compact?: boolean;
  showText?: boolean;
}>();
</script>

<template>
  <span class="inline-flex items-center gap-2 font-semibold text-foreground">
    <!-- Icon mark -->
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      class="shrink-0 text-primary"
      :class="compact ? 'size-6' : 'size-7'"
      aria-hidden="true"
    >
      <rect x="2" y="2" width="9" height="9" rx="2" fill="currentColor" opacity="0.9" />
      <rect x="13" y="2" width="9" height="9" rx="2" fill="currentColor" opacity="0.5" />
      <rect x="2" y="13" width="9" height="9" rx="2" fill="currentColor" opacity="0.5" />
      <rect x="13" y="13" width="9" height="9" rx="2" fill="currentColor" opacity="0.25" />
    </svg>
    <!-- Wordmark -->
    <span v-if="showText !== false" class="truncate text-sm tracking-tight">
      speculoos
    </span>
  </span>
</template>
