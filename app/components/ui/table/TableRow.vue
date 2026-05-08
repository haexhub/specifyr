<script setup lang="ts">
import TableRow from "~/components/shadcn/table/TableRow.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <TableRow v-bind="$attrs"><slot /></TableRow>
</template>
