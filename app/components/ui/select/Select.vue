<script setup lang="ts">
import Select from "~/components/shadcn/select/Select.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <Select v-bind="$attrs"><slot /></Select>
</template>
