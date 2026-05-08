<script setup lang="ts">
import SelectItemText from "~/components/shadcn/select/SelectItemText.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <SelectItemText v-bind="$attrs"><slot /></SelectItemText>
</template>
