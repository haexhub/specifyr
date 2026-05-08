<script setup lang="ts">
import CardFooter from "~/components/shadcn/card/CardFooter.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <CardFooter v-bind="$attrs"><slot /></CardFooter>
</template>
