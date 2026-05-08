<script setup lang="ts">
import TableBody from "~/components/shadcn/table/TableBody.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <TableBody v-bind="$attrs"><slot /></TableBody>
</template>
