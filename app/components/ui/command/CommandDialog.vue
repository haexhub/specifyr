<script setup lang="ts">
import CommandDialog from "~/components/shadcn/command/CommandDialog.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <CommandDialog v-bind="$attrs"><slot /></CommandDialog>
</template>
