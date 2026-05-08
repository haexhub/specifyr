<script setup lang="ts">
import CommandSeparator from "~/components/shadcn/command/CommandSeparator.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <CommandSeparator v-bind="$attrs"><slot /></CommandSeparator>
</template>
