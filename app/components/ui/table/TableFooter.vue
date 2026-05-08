<script setup lang="ts">
import TableFooter from "~/components/shadcn/table/TableFooter.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <TableFooter v-bind="$attrs"><slot /></TableFooter>
</template>
