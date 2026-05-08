<script setup lang="ts">
import TableEmpty from "~/components/shadcn/table/TableEmpty.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <TableEmpty v-bind="$attrs"><slot /></TableEmpty>
</template>
