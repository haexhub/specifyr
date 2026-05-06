<script setup lang="ts">
import { Building2, KeyRound, LogOut, User as UserIcon } from "lucide-vue-next";

const { me, logoutUrl } = useMe();
</script>

<template>
  <div class="mx-auto w-full max-w-3xl px-6 py-8">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold">Settings</h1>
        <p v-if="me" class="mt-1 text-sm text-muted-foreground">
          Logged in as <span class="font-mono">{{ me.email }}</span>
        </p>
        <p v-else class="mt-1 text-sm text-destructive">
          Not authenticated. Settings require an IDP login (or
          <span class="font-mono">SPECIFYR_DEV_USER_EMAIL</span> in dev).
        </p>
      </div>
      <a
        v-if="me && logoutUrl !== '#'"
        :href="logoutUrl"
        class="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
      >
        <LogOut class="size-4" /> Logout
      </a>
    </div>

    <ul class="mt-8 grid gap-3 sm:grid-cols-1">
      <li>
        <NuxtLink
          to="/settings/orgs"
          class="flex items-start gap-3 rounded-lg border border-border p-4 transition hover:bg-accent/50"
        >
          <Building2 class="mt-0.5 size-5 shrink-0 opacity-80" />
          <div>
            <div class="font-medium">Organizations</div>
            <div class="mt-0.5 text-sm text-muted-foreground">
              Create orgs, invite members, share LLM credentials within a team.
            </div>
          </div>
        </NuxtLink>
      </li>
      <li>
        <div
          class="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-4 opacity-60"
        >
          <KeyRound class="mt-0.5 size-5 shrink-0 opacity-80" />
          <div>
            <div class="font-medium">LLM credentials</div>
            <div class="mt-0.5 text-sm text-muted-foreground">
              Manage API keys for Anthropic / OpenAI / Google, log in to Claude
              Pro/Max via OAuth. <span class="italic">Coming in phase 4.</span>
            </div>
          </div>
        </div>
      </li>
      <li>
        <div
          class="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-4 opacity-60"
        >
          <UserIcon class="mt-0.5 size-5 shrink-0 opacity-80" />
          <div>
            <div class="font-medium">Profile</div>
            <div class="mt-0.5 text-sm text-muted-foreground">
              Display name, language preferences. <span class="italic">Phase 10.</span>
            </div>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>
