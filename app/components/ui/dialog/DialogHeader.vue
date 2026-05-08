<script setup lang="ts">
import DialogHeader from "~/components/shadcn/dialog/DialogHeader.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <DialogHeader v-bind="$attrs"><slot /></DialogHeader>
</template>
