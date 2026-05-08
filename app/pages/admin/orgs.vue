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
    <table v-else class="mt-6 w-full text-sm">
      <thead class="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
        <tr>
          <th class="py-2 font-medium">Org</th>
          <th class="py-2 font-medium">Owner</th>
          <th class="py-2 font-medium">Members</th>
          <th class="py-2 font-medium">Projects</th>
          <th class="py-2 font-medium">Created</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="o in data.orgs" :key="o.id" class="border-b border-border/50">
          <td class="py-3">
            <div class="font-medium">{{ o.name }}</div>
            <div class="font-mono text-xs text-muted-foreground">/{{ o.slug }}</div>
          </td>
          <td class="py-3 font-mono text-xs">{{ o.ownerEmail ?? "—" }}</td>
          <td class="py-3">{{ o.memberCount }}</td>
          <td class="py-3">{{ o.projectCount }}</td>
          <td class="py-3 text-muted-foreground">
            {{ new Date(o.createdAt).toLocaleDateString() }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
