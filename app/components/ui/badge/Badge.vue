<script setup lang="ts">
import Badge from "~/components/shadcn/badge/Badge.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <Badge v-bind="$attrs"><slot /></Badge>
</template>
