<script setup lang="ts">
import SelectLabel from "~/components/shadcn/select/SelectLabel.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <SelectLabel v-bind="$attrs"><slot /></SelectLabel>
</template>
