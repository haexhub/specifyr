<script setup lang="ts">
import CommandShortcut from "~/components/shadcn/command/CommandShortcut.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <CommandShortcut v-bind="$attrs"><slot /></CommandShortcut>
</template>
