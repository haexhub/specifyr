<script setup lang="ts">
import Card from "~/components/shadcn/card/Card.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <Card v-bind="$attrs"><slot /></Card>
</template>
