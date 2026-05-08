<script setup lang="ts">
definePageMeta({ layout: "workspace", middleware: ["platform-admin"] });

import { ShieldCheck, Users } from "lucide-vue-next";

interface AdminUserRow {
  id: string;
  email: string;
  displayName: string | null;
  isPlatformAdmin: boolean;
  createdAt: string;
  orgCount: number;
}
interface UsersResponse {
  users: AdminUserRow[];
  pagination: { limit: number; offset: number; total: number };
}

const { data, pending } = await useFetch<UsersResponse>("/api/admin/users", {
  default: () => ({ users: [], pagination: { limit: 50, offset: 0, total: 0 } }),
});
</script>

<template>
  <div>
    <nav class="flex flex-wrap gap-2 text-xs">
      <NuxtLink
        to="/admin/users"
        class="rounded-md bg-muted px-3 py-1 font-medium"
      >
        <Users class="mr-1 inline size-3.5" /> Users
      </NuxtLink>
      <NuxtLink
        to="/admin/orgs"
        class="rounded-md px-3 py-1 text-muted-foreground hover:bg-muted"
      >
        Organizations
      </NuxtLink>
      <NuxtLink
        to="/admin/settings/registration"
        class="rounded-md px-3 py-1 text-muted-foreground hover:bg-muted"
      >
        Settings
      </NuxtLink>
    </nav>

    <h1 class="mt-4 text-2xl font-semibold">Users</h1>
    <p class="mt-1 text-sm text-muted-foreground">
      All users that have signed in to specifyr at least once.
      Total: {{ data.pagination.total }}.
    </p>

    <div v-if="pending" class="mt-6 text-sm text-muted-foreground">Loading…</div>
    <UiTable v-else class="mt-6">
      <UiTableHeader>
        <UiTableRow>
          <UiTableHead>User</UiTableHead>
          <UiTableHead>Orgs</UiTableHead>
          <UiTableHead>Joined</UiTableHead>
          <UiTableHead>Flags</UiTableHead>
        </UiTableRow>
      </UiTableHeader>
      <UiTableBody>
        <UiTableRow v-for="u in data.users" :key="u.id">
          <UiTableCell>
            <div class="font-medium">{{ u.displayName || u.email }}</div>
            <div class="font-mono text-xs text-muted-foreground">{{ u.email }}</div>
          </UiTableCell>
          <UiTableCell>{{ u.orgCount }}</UiTableCell>
          <UiTableCell class="text-muted-foreground">
            {{ new Date(u.createdAt).toLocaleDateString() }}
          </UiTableCell>
          <UiTableCell>
            <span
              v-if="u.isPlatformAdmin"
              class="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-600"
            >
              <ShieldCheck class="size-3" /> platform admin
            </span>
          </UiTableCell>
        </UiTableRow>
      </UiTableBody>
    </UiTable>
  </div>
</template>
