<script setup lang="ts">
// Nested-route parent for /settings/*. Owns the shared layout so child
// pages (settings/index, settings/orgs/*, settings/me/*) don't each
// redefine their outer wrapper. Outer width/padding comes from the
// `default` layout; this file is where settings-wide chrome (side nav,
// breadcrumbs, …) would live if added later.
</script>

<template>
  <NuxtPage />
</template>
