<script setup lang="ts">
import { Ban, ShieldCheck, Trash2, Undo2 } from "lucide-vue-next";
import { Button } from "~/components/shadcn/button";
import ConfirmDialog from "~/components/ui/ConfirmDialog.vue";

interface AdminUserRow {
  id: string;
  email: string;
  displayName: string | null;
  isPlatformAdmin: boolean;
  blockedAt: string | null;
  createdAt: string;
  orgCount: number;
}
interface UsersResponse {
  users: AdminUserRow[];
  pagination: { limit: number; offset: number; total: number };
}

const { data, pending, refresh } = await useFetch<UsersResponse>("/api/admin/users", {
  default: () => ({ users: [], pagination: { limit: 50, offset: 0, total: 0 } }),
});

const { data: me } = await useFetch<{ id?: string } | null>("/api/me", {
  default: () => null,
});

const { locale } = useI18n();

function formatJoinedAt(value: string) {
  return new Date(value).toLocaleDateString(locale.value, { timeZone: "UTC" });
}

type Action = "block" | "unblock" | "delete";
const pendingAction = ref<{ user: AdminUserRow; action: Action } | null>(null);
const busy = ref(false);
const errorMessage = ref<string | null>(null);

function ask(user: AdminUserRow, action: Action) {
  errorMessage.value = null;
  pendingAction.value = { user, action };
}

const dialogProps = computed(() => {
  const p = pendingAction.value;
  if (!p) return null;
  const who = p.user.displayName || p.user.email;
  if (p.action === "block") {
    return {
      title: "Block user?",
      message: `${who} will no longer be able to sign in.`,
      details:
        "Existing sessions remain valid until they expire — auth middleware rejects on the next request.",
      confirmLabel: "Block",
      destructive: true,
    };
  }
  if (p.action === "unblock") {
    return {
      title: "Unblock user?",
      message: `${who} will be able to sign in again on their next request.`,
      confirmLabel: "Unblock",
      destructive: false,
    };
  }
  return {
    title: "Delete user?",
    message: `${who} will be permanently removed.`,
    details:
      "Memberships and runner sessions are deleted with them. If they own an org, transfer ownership first or the delete is rejected.",
    confirmLabel: "Delete",
    destructive: true,
  };
});

async function confirm() {
  const p = pendingAction.value;
  if (!p) return;
  busy.value = true;
  errorMessage.value = null;
  try {
    if (p.action === "delete") {
      await $fetch(`/api/admin/users/${p.user.id}`, { method: "DELETE" });
    } else {
      await $fetch(`/api/admin/users/${p.user.id}`, {
        method: "PATCH",
        body: { blocked: p.action === "block" },
      });
    }
    pendingAction.value = null;
    await refresh();
  } catch (err: unknown) {
    errorMessage.value =
      (err as { statusMessage?: string })?.statusMessage ??
      (err instanceof Error ? err.message : "action failed");
  } finally {
    busy.value = false;
  }
}

function cancel() {
  if (busy.value) return;
  pendingAction.value = null;
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-semibold">Users</h1>
    <p class="mt-1 text-sm text-muted-foreground">
      All users that have signed in to specifyr at least once.
      Total: {{ data.pagination.total }}.
    </p>

    <div v-if="errorMessage" class="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {{ errorMessage }}
    </div>

    <div v-if="pending" class="mt-6 text-sm text-muted-foreground">Loading…</div>
    <Table v-else class="mt-6">
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead>Orgs</TableHead>
          <TableHead>Joined</TableHead>
          <TableHead>Flags</TableHead>
          <TableHead class="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="u in data.users" :key="u.id" :class="{ 'opacity-60': u.blockedAt }">
          <TableCell>
            <div class="font-medium">{{ u.displayName || u.email }}</div>
            <div class="font-mono text-xs text-muted-foreground">{{ u.email }}</div>
          </TableCell>
          <TableCell>{{ u.orgCount }}</TableCell>
          <TableCell class="text-muted-foreground">
            {{ formatJoinedAt(u.createdAt) }}
          </TableCell>
          <TableCell>
            <div class="flex flex-wrap gap-1">
              <span
                v-if="u.isPlatformAdmin"
                class="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-600"
              >
                <ShieldCheck class="size-3" /> platform admin
              </span>
              <span
                v-if="u.blockedAt"
                class="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive"
              >
                <Ban class="size-3" /> blocked
              </span>
            </div>
          </TableCell>
          <TableCell class="text-right">
            <div class="flex justify-end gap-1">
              <Button
                v-if="!u.blockedAt"
                variant="outline"
                size="sm"
                :disabled="u.id === me?.id"
                :title="u.id === me?.id ? 'Cannot block yourself' : 'Block sign-in'"
                @click="ask(u, 'block')"
              >
                <Ban class="size-3.5" /> Block
              </Button>
              <Button
                v-else
                variant="outline"
                size="sm"
                @click="ask(u, 'unblock')"
              >
                <Undo2 class="size-3.5" /> Unblock
              </Button>
              <Button
                variant="outline"
                size="sm"
                class="text-destructive hover:bg-destructive/10 hover:text-destructive"
                :disabled="u.id === me?.id"
                :title="u.id === me?.id ? 'Cannot delete yourself' : 'Delete permanently'"
                @click="ask(u, 'delete')"
              >
                <Trash2 class="size-3.5" /> Delete
              </Button>
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>

    <ConfirmDialog
      v-if="dialogProps"
      :open="pendingAction !== null"
      :title="dialogProps.title"
      :message="dialogProps.message"
      :details="dialogProps.details"
      :confirm-label="dialogProps.confirmLabel"
      :destructive="dialogProps.destructive"
      :busy="busy"
      @confirm="confirm"
      @cancel="cancel"
      @update:open="(v) => { if (!v) cancel(); }"
    />
  </div>
</template>
