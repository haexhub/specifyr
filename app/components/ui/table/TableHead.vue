<script setup lang="ts">
import TableHead from "~/components/shadcn/table/TableHead.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <TableHead v-bind="$attrs"><slot /></TableHead>
</template>
