<script setup lang="ts">
import SelectTrigger from "~/components/shadcn/select/SelectTrigger.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <SelectTrigger v-bind="$attrs"><slot /></SelectTrigger>
</template>
