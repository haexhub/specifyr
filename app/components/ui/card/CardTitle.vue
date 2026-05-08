<script setup lang="ts">
import CardTitle from "~/components/shadcn/card/CardTitle.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <CardTitle v-bind="$attrs"><slot /></CardTitle>
</template>
