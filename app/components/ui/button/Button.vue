<script setup lang="ts">
import Button from "~/components/shadcn/button/Button.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <Button v-bind="$attrs"><slot /></Button>
</template>
