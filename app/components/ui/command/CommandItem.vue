<script setup lang="ts">
import CommandItem from "~/components/shadcn/command/CommandItem.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <CommandItem v-bind="$attrs"><slot /></CommandItem>
</template>
