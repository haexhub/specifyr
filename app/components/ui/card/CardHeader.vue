<script setup lang="ts">
import CardHeader from "~/components/shadcn/card/CardHeader.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <CardHeader v-bind="$attrs"><slot /></CardHeader>
</template>
