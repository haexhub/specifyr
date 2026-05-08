<script setup lang="ts">
import CommandInput from "~/components/shadcn/command/CommandInput.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <CommandInput v-bind="$attrs"><slot /></CommandInput>
</template>
