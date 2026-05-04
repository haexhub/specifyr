<script setup lang="ts">
withDefaults(
  defineProps<{
    compact?: boolean;
    showText?: boolean;
    size?: "sm" | "md" | "lg" | "hero";
  }>(),
  {
    compact: false,
    showText: true,
    size: "md"
  }
);

const sizeClasses = {
  sm: "size-8",
  md: "size-10",
  lg: "size-14",
  hero: "size-20"
};
</script>

<template>
  <span class="inline-flex min-w-0 items-center gap-2">
    <img
      src="/specifyr-logo.png"
      alt="specifyr Gewuerzspekulatius mit Speckit-Spross"
      class="shrink-0 object-contain"
      :class="compact ? sizeClasses.sm : sizeClasses[size]"
    >
    <span v-if="showText && !compact" class="truncate text-sm font-semibold tracking-tight">
      specifyr
    </span>
  </span>
</template>
