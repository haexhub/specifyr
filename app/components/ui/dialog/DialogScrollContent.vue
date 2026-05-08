<script setup lang="ts">
import DialogScrollContent from "~/components/shadcn/dialog/DialogScrollContent.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <DialogScrollContent v-bind="$attrs"><slot /></DialogScrollContent>
</template>
