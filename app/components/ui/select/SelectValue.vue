<script setup lang="ts">
import SelectValue from "~/components/shadcn/select/SelectValue.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <SelectValue v-bind="$attrs"><slot /></SelectValue>
</template>
