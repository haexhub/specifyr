<script setup lang="ts">
import DialogTrigger from "~/components/shadcn/dialog/DialogTrigger.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <DialogTrigger v-bind="$attrs"><slot /></DialogTrigger>
</template>
