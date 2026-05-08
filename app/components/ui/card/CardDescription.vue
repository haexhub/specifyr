<script setup lang="ts">
import CardDescription from "~/components/shadcn/card/CardDescription.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <CardDescription v-bind="$attrs"><slot /></CardDescription>
</template>
