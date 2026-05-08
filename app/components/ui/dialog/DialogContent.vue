<script setup lang="ts">
import DialogContent from "~/components/shadcn/dialog/DialogContent.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <DialogContent v-bind="$attrs"><slot /></DialogContent>
</template>
