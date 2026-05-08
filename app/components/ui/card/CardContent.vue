<script setup lang="ts">
import CardContent from "~/components/shadcn/card/CardContent.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <CardContent v-bind="$attrs"><slot /></CardContent>
</template>
