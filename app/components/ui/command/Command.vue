<script setup lang="ts">
import Command from "~/components/shadcn/command/Command.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <Command v-bind="$attrs"><slot /></Command>
</template>
