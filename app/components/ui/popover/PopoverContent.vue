<script setup lang="ts">
import PopoverContent from "~/components/shadcn/popover/PopoverContent.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <PopoverContent v-bind="$attrs"><slot /></PopoverContent>
</template>
