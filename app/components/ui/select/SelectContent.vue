<script setup lang="ts">
import SelectContent from "~/components/shadcn/select/SelectContent.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <SelectContent v-bind="$attrs"><slot /></SelectContent>
</template>
