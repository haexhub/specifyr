<script setup lang="ts">
definePageMeta({ layout: "workspace", middleware: ["platform-admin"] });
// Landing page just bounces to the user list — having an explicit
// /admin route makes deep-linking from the topbar simple, and
// avoiding a dashboard with empty widgets keeps the UX honest.
await navigateTo("/admin/users");
</script>

<template>
  <div class="px-6 py-12 text-sm text-muted-foreground">Redirecting…</div>
</template>
