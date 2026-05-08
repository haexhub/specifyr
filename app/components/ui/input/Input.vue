<script setup lang="ts">
import Input from "~/components/shadcn/input/Input.vue";
defineOptions({ inheritAttrs: false });
</script>

<template>
  <Input v-bind="$attrs"><slot /></Input>
</template>
