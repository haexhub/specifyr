<script setup lang="ts">
import SelectSeparator from "~/components/shadcn/select/SelectSeparator.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <SelectSeparator v-bind="$attrs"><slot /></SelectSeparator>
</template>
