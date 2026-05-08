<script setup lang="ts">
import TableCell from "~/components/shadcn/table/TableCell.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <TableCell v-bind="$attrs"><slot /></TableCell>
</template>
