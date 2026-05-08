<script setup lang="ts">
import DialogDescription from "~/components/shadcn/dialog/DialogDescription.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <DialogDescription v-bind="$attrs"><slot /></DialogDescription>
</template>
