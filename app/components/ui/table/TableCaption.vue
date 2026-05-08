<script setup lang="ts">
import TableCaption from "~/components/shadcn/table/TableCaption.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <TableCaption v-bind="$attrs"><slot /></TableCaption>
</template>
