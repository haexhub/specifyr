<script setup lang="ts">
definePageMeta({ layout: "workspace", middleware: ["platform-admin"] });

import { Building2 } from "lucide-vue-next";

interface AdminOrgRow {
  id: string;
  slug: string;
  name: string;
  ownerUserId: string;
  ownerEmail: string | null;
  createdAt: string;
  memberCount: number;
  projectCount: number;
}
interface OrgsResponse {
  orgs: AdminOrgRow[];
  pagination: { limit: number; offset: number; total: number };
}

const { data, pending } = await useFetch<OrgsResponse>("/api/admin/orgs", {
  default: () => ({ orgs: [], pagination: { limit: 50, offset: 0, total: 0 } }),
});
</script>

<template>
  <div>
    <nav class="flex flex-wrap gap-2 text-xs">
      <NuxtLink
        to="/admin/users"
        class="rounded-md px-3 py-1 text-muted-foreground hover:bg-muted"
      >
        Users
      </NuxtLink>
      <NuxtLink
        to="/admin/orgs"
        class="rounded-md bg-muted px-3 py-1 font-medium"
      >
        <Building2 class="mr-1 inline size-3.5" /> Organizations
      </NuxtLink>
      <NuxtLink
        to="/admin/settings/registration"
        class="rounded-md px-3 py-1 text-muted-foreground hover:bg-muted"
      >
        Settings
      </NuxtLink>
    </nav>

    <h1 class="mt-4 text-2xl font-semibold">Organizations</h1>
    <p class="mt-1 text-sm text-muted-foreground">
      Total: {{ data.pagination.total }}.
    </p>

    <div v-if="pending" class="mt-6 text-sm text-muted-foreground">Loading…</div>
    <UiTable v-else class="mt-6">
      <UiTableHeader>
        <UiTableRow>
          <UiTableHead>Org</UiTableHead>
          <UiTableHead>Owner</UiTableHead>
          <UiTableHead>Members</UiTableHead>
          <UiTableHead>Projects</UiTableHead>
          <UiTableHead>Created</UiTableHead>
        </UiTableRow>
      </UiTableHeader>
      <UiTableBody>
        <UiTableRow v-for="o in data.orgs" :key="o.id">
          <UiTableCell>
            <div class="font-medium">{{ o.name }}</div>
            <div class="font-mono text-xs text-muted-foreground">/{{ o.slug }}</div>
          </UiTableCell>
          <UiTableCell class="font-mono text-xs">{{ o.ownerEmail ?? "—" }}</UiTableCell>
          <UiTableCell>{{ o.memberCount }}</UiTableCell>
          <UiTableCell>{{ o.projectCount }}</UiTableCell>
          <UiTableCell class="text-muted-foreground">
            {{ new Date(o.createdAt).toLocaleDateString() }}
          </UiTableCell>
        </UiTableRow>
      </UiTableBody>
    </UiTable>
  </div>
</template>
