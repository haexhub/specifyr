<script setup lang="ts">
import DialogFooter from "~/components/shadcn/dialog/DialogFooter.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <DialogFooter v-bind="$attrs"><slot /></DialogFooter>
</template>
