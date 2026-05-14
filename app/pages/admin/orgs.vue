<script setup lang="ts">
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
    <h1 class="text-2xl font-semibold">Organizations</h1>
    <p class="mt-1 text-sm text-muted-foreground">
      Total: {{ data.pagination.total }}.
    </p>

    <div v-if="pending" class="mt-6 text-sm text-muted-foreground">Loading…</div>
    <Table v-else class="mt-6">
      <TableHeader>
        <TableRow>
          <TableHead>Org</TableHead>
          <TableHead>Owner</TableHead>
          <TableHead>Members</TableHead>
          <TableHead>Projects</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="o in data.orgs" :key="o.id">
          <TableCell>
            <div class="font-medium">{{ o.name }}</div>
            <div class="font-mono text-xs text-muted-foreground">/{{ o.slug }}</div>
          </TableCell>
          <TableCell class="font-mono text-xs">{{ o.ownerEmail ?? "—" }}</TableCell>
          <TableCell>{{ o.memberCount }}</TableCell>
          <TableCell>{{ o.projectCount }}</TableCell>
          <TableCell class="text-muted-foreground">
            {{ new Date(o.createdAt).toLocaleDateString() }}
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>
