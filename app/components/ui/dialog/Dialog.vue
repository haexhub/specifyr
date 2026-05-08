<script setup lang="ts">
import Dialog from "~/components/shadcn/dialog/Dialog.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <Dialog v-bind="$attrs"><slot /></Dialog>
</template>
