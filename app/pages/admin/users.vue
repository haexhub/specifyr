<script setup lang="ts">
import { ShieldCheck } from "lucide-vue-next";

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
    <h1 class="text-2xl font-semibold">Users</h1>
    <p class="mt-1 text-sm text-muted-foreground">
      All users that have signed in to specifyr at least once.
      Total: {{ data.pagination.total }}.
    </p>

    <div v-if="pending" class="mt-6 text-sm text-muted-foreground">Loading…</div>
    <Table v-else class="mt-6">
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead>Orgs</TableHead>
          <TableHead>Joined</TableHead>
          <TableHead>Flags</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="u in data.users" :key="u.id">
          <TableCell>
            <div class="font-medium">{{ u.displayName || u.email }}</div>
            <div class="font-mono text-xs text-muted-foreground">{{ u.email }}</div>
          </TableCell>
          <TableCell>{{ u.orgCount }}</TableCell>
          <TableCell class="text-muted-foreground">
            {{ new Date(u.createdAt).toLocaleDateString() }}
          </TableCell>
          <TableCell>
            <span
              v-if="u.isPlatformAdmin"
              class="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-600"
            >
              <ShieldCheck class="size-3" /> platform admin
            </span>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>
