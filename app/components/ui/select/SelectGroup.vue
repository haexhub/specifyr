<script setup lang="ts">
import SelectGroup from "~/components/shadcn/select/SelectGroup.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <SelectGroup v-bind="$attrs"><slot /></SelectGroup>
</template>
