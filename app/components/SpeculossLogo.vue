<script setup lang="ts">
defineProps<{
  compact?: boolean;
  showText?: boolean;
  large?: boolean;
}>();
</script>

<template>
  <span class="inline-flex items-center gap-2 font-semibold text-foreground" :class="large ? 'flex-col gap-3' : ''">
    <img
      src="/speculoss-logo.png"
      alt="speculoss"
      class="shrink-0 object-contain"
      :class="large ? 'size-20' : compact ? 'size-6' : 'size-7'"
    />
    <span v-if="showText !== false" :class="large ? 'text-3xl tracking-tight' : 'truncate text-sm tracking-tight'">
      speculoos
    </span>
  </span>
</template>
