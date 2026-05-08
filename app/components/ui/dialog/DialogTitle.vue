<script setup lang="ts">
import DialogTitle from "~/components/shadcn/dialog/DialogTitle.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <DialogTitle v-bind="$attrs"><slot /></DialogTitle>
</template>
