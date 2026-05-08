<script setup lang="ts">
import Popover from "~/components/shadcn/popover/Popover.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <Popover v-bind="$attrs"><slot /></Popover>
</template>
