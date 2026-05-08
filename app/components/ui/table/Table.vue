<script setup lang="ts">
import Table from "~/components/shadcn/table/Table.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <Table v-bind="$attrs"><slot /></Table>
</template>
