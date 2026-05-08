<script setup lang="ts">
import TableHeader from "~/components/shadcn/table/TableHeader.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <TableHeader v-bind="$attrs"><slot /></TableHeader>
</template>
