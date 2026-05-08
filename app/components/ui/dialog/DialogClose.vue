<script setup lang="ts">
import DialogClose from "~/components/shadcn/dialog/DialogClose.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <DialogClose v-bind="$attrs"><slot /></DialogClose>
</template>
