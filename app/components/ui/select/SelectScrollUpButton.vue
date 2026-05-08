<script setup lang="ts">
import SelectScrollUpButton from "~/components/shadcn/select/SelectScrollUpButton.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <SelectScrollUpButton v-bind="$attrs"><slot /></SelectScrollUpButton>
</template>
