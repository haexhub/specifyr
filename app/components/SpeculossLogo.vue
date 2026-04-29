<script setup lang="ts">
defineProps<{
  compact?: boolean;
  showText?: boolean;
}>();
</script>

<template>
  <span class="inline-flex items-center gap-2 font-semibold text-foreground">
    <img
      src="/speculoss-logo.png"
      alt="speculoss"
      class="shrink-0 object-contain"
      :class="compact ? 'size-6' : 'size-7'"
    />
    <span v-if="showText !== false" class="truncate text-sm tracking-tight">
      speculoos
    </span>
  </span>
</template>
