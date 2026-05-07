<script setup lang="ts">
import { Copy, KeyRound, UserPlus } from "lucide-vue-next";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

interface MemberRow {
  userId: string;
  email: string;
  displayName: string | null;
  role: "admin" | "member";
  joinedAt: string;
}

interface MembersResponse {
  org: { id: string; slug: string; name: string; createdAt: string };
  myRole: "admin" | "member";
  members: MemberRow[];
}

const route = useRoute();
const slug = computed(() => String(route.params.slug));

const { data, refresh } = await useFetch<MembersResponse>(
  () => `/api/orgs/${slug.value}/members`,
  { default: () => null },
);

const inviteEmail = ref("");
const inviteRole = ref<"admin" | "member">("member");
const inviting = ref(false);
const inviteError = ref<string | null>(null);
const inviteResult = ref<{ acceptPath: string; expiresAt: string } | null>(null);
const copied = ref(false);

async function sendInvite() {
  inviteError.value = null;
  inviteResult.value = null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inviteEmail.value.trim())) {
    inviteError.value = "Please enter a valid email.";
    return;
  }
  inviting.value = true;
  try {
    const res = await $fetch<{ acceptPath: string; expiresAt: string }>(
      `/api/orgs/${slug.value}/invites`,
      {
        method: "POST",
        body: { email: inviteEmail.value.trim(), role: inviteRole.value },
      },
    );
    inviteResult.value = res;
    inviteEmail.value = "";
  } catch (err: unknown) {
    inviteError.value =
      (err as { statusMessage?: string })?.statusMessage ?? "could not create invite";
  } finally {
    inviting.value = false;
  }
}

const inviteUrl = computed(() => {
  if (!inviteResult.value) return "";
  if (typeof window === "undefined") return inviteResult.value.acceptPath;
  return `${window.location.origin}${inviteResult.value.acceptPath}`;
});

async function copyLink() {
  if (!inviteUrl.value) return;
  await navigator.clipboard.writeText(inviteUrl.value);
  copied.value = true;
  setTimeout(() => (copied.value = false), 2000);
}
</script>

<template>
  <div class="mx-auto w-full max-w-3xl px-6 py-8">
    <NuxtLink
      to="/settings/orgs"
      class="text-xs text-muted-foreground hover:text-foreground"
    >
      ← Organizations
    </NuxtLink>

    <template v-if="data">
      <h1 class="mt-2 text-2xl font-semibold">{{ data.org.name }}</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        <span class="font-mono">/{{ data.org.slug }}</span> · You are
        <span class="font-medium">{{ data.myRole }}</span>
      </p>

      <NuxtLink
        :to="`/settings/orgs/${data.org.slug}/llm`"
        class="mt-3 inline-flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5 text-xs hover:bg-muted/60"
      >
        <KeyRound class="size-3.5" /> LLM credentials
      </NuxtLink>

      <section class="mt-8">
        <h2 class="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Members ({{ data.members.length }})
        </h2>
        <ul class="mt-3 divide-y divide-border rounded-lg border border-border">
          <li
            v-for="m in data.members"
            :key="m.userId"
            class="flex items-center justify-between gap-3 px-4 py-3"
          >
            <div class="min-w-0">
              <div class="truncate text-sm font-medium">
                {{ m.displayName || m.email }}
              </div>
              <div class="truncate font-mono text-xs text-muted-foreground">
                {{ m.email }}
              </div>
            </div>
            <span
              class="rounded-md px-2 py-0.5 text-xs font-medium"
              :class="m.role === 'admin' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'"
            >
              {{ m.role }}
            </span>
          </li>
        </ul>
      </section>

      <section v-if="data.myRole === 'admin'" class="mt-8">
        <h2 class="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <UserPlus class="size-4" /> Invite a member
        </h2>
        <form
          class="mt-3 grid gap-3 rounded-lg border border-border bg-muted/30 p-4 sm:grid-cols-[1fr_auto_auto]"
          @submit.prevent="sendInvite"
        >
          <Input
            v-model="inviteEmail"
            type="email"
            placeholder="colleague@example.com"
            :disabled="inviting"
          />
          <select
            v-model="inviteRole"
            class="rounded-md border border-input bg-background px-3 text-sm"
            :disabled="inviting"
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
          <Button type="submit" :disabled="inviting">
            {{ inviting ? "Creating…" : "Create invite" }}
          </Button>
        </form>
        <p v-if="inviteError" class="mt-2 text-sm text-destructive">
          {{ inviteError }}
        </p>

        <div
          v-if="inviteResult"
          class="mt-3 rounded-lg border border-primary/30 bg-primary/5 p-3"
        >
          <p class="text-sm">
            Invite created. Send this link to your colleague — they need to be
            logged in via Authelia to redeem it.
          </p>
          <div class="mt-2 flex items-center gap-2">
            <code class="flex-1 truncate rounded-md bg-background px-2 py-1.5 text-xs">{{
              inviteUrl
            }}</code>
            <Button size="sm" variant="outline" type="button" @click="copyLink">
              <Copy class="size-3.5" /> {{ copied ? "Copied!" : "Copy" }}
            </Button>
          </div>
          <p class="mt-2 text-xs text-muted-foreground">
            Expires {{ new Date(inviteResult.expiresAt).toLocaleString() }}
          </p>
        </div>
      </section>
    </template>

    <p v-else class="mt-4 text-sm text-muted-foreground">Loading…</p>
  </div>
</template>
