<script setup lang="ts">
import CommandGroup from "~/components/shadcn/command/CommandGroup.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <CommandGroup v-bind="$attrs"><slot /></CommandGroup>
</template>
