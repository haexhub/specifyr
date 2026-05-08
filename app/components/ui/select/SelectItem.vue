<script setup lang="ts">
import SelectItem from "~/components/shadcn/select/SelectItem.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <SelectItem v-bind="$attrs"><slot /></SelectItem>
</template>
