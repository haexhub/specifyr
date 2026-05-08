<script setup lang="ts">
import CommandList from "~/components/shadcn/command/CommandList.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <CommandList v-bind="$attrs"><slot /></CommandList>
</template>
