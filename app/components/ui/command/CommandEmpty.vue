<script setup lang="ts">
import CommandEmpty from "~/components/shadcn/command/CommandEmpty.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <CommandEmpty v-bind="$attrs"><slot /></CommandEmpty>
</template>
