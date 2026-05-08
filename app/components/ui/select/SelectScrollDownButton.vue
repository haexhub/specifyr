<script setup lang="ts">
import SelectScrollDownButton from "~/components/shadcn/select/SelectScrollDownButton.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <SelectScrollDownButton v-bind="$attrs"><slot /></SelectScrollDownButton>
</template>
