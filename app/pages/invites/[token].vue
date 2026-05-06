<script setup lang="ts">
import { Building2 } from "lucide-vue-next";
import { Button } from "~/components/ui/button";

interface InvitePreview {
  orgName: string;
  orgSlug: string;
  invitedEmail: string;
  invitedRole: "admin" | "member";
  expiresAt: string;
  status: "pending" | "accepted" | "expired" | "revoked";
}

const route = useRoute();
const token = computed(() => String(route.params.token));

const { data: invite, error: previewError } = await useFetch<InvitePreview>(
  () => `/api/invites/${token.value}`,
  { default: () => null },
);

const accepting = ref(false);
const acceptError = ref<string | null>(null);

async function accept() {
  accepting.value = true;
  acceptError.value = null;
  try {
    const res = await $fetch<{ orgSlug: string; role: string }>(
      `/api/invites/${token.value}/accept`,
      { method: "POST" },
    );
    await navigateTo(`/settings/orgs/${res.orgSlug}`);
  } catch (err: unknown) {
    acceptError.value =
      (err as { statusMessage?: string })?.statusMessage ?? "could not accept";
  } finally {
    accepting.value = false;
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-md px-6 py-12">
    <div v-if="previewError" class="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
      Invite not found or invalid.
    </div>

    <div
      v-else-if="invite"
      class="rounded-lg border border-border bg-card p-6"
    >
      <div class="flex items-start gap-3">
        <Building2 class="mt-1 size-6 shrink-0 opacity-80" />
        <div>
          <h1 class="text-xl font-semibold">{{ invite.orgName }}</h1>
          <p class="mt-1 text-sm text-muted-foreground">
            You've been invited as <span class="font-medium">{{ invite.invitedRole }}</span>.
          </p>
        </div>
      </div>

      <div
        v-if="invite.status !== 'pending'"
        class="mt-4 rounded-md border border-border bg-muted/40 p-3 text-sm"
      >
        This invite is <span class="font-medium">{{ invite.status }}</span> and can no longer be used.
      </div>

      <div v-else class="mt-5 space-y-3">
        <div class="rounded-md bg-muted/30 p-3 text-xs text-muted-foreground">
          Originally addressed to
          <span class="font-mono">{{ invite.invitedEmail }}</span>. The
          invite is bound to whoever is logged in (you), not the email above.
        </div>
        <Button class="w-full" :disabled="accepting" @click="accept">
          {{ accepting ? "Joining…" : `Join ${invite.orgName}` }}
        </Button>
        <p v-if="acceptError" class="text-sm text-destructive">{{ acceptError }}</p>
        <p class="text-center text-xs text-muted-foreground">
          Expires {{ new Date(invite.expiresAt).toLocaleString() }}
        </p>
      </div>
    </div>
  </div>
</template>
