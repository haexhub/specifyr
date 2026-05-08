<script setup lang="ts">
import PopoverTrigger from "~/components/shadcn/popover/PopoverTrigger.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <PopoverTrigger v-bind="$attrs"><slot /></PopoverTrigger>
</template>
