<script setup lang="ts">
type Policy = "open" | "domain" | "closed";

interface SettingsResponse {
  registration: {
    policy: Policy;
    allowedDomains: string[];
  };
  platformAdmins: {
    emails: string[];
    envEmails: string[];
  };
}

const emptySettings: SettingsResponse = {
  registration: { policy: "open", allowedDomains: [] },
  platformAdmins: { emails: [], envEmails: [] },
};

const { data, refresh } = await useFetch<SettingsResponse>("/api/admin/settings", {
  default: () => emptySettings,
});

const policy = ref<Policy>(data.value.registration.policy);
const domainsText = ref(data.value.registration.allowedDomains.join("\n"));
const adminEmailsText = ref(data.value.platformAdmins.emails.join("\n"));

const savingRegistration = ref(false);
const savingAdmins = ref(false);
const registrationMessage = ref<string | null>(null);
const registrationError = ref<string | null>(null);
const adminsMessage = ref<string | null>(null);
const adminsError = ref<string | null>(null);

watch(data, (d) => {
  if (!d) return;
  policy.value = d.registration.policy;
  domainsText.value = d.registration.allowedDomains.join("\n");
  adminEmailsText.value = d.platformAdmins.emails.join("\n");
});

async function saveRegistration() {
  savingRegistration.value = true;
  registrationMessage.value = null;
  registrationError.value = null;
  try {
    const allowedDomains = domainsText.value
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    await $fetch("/api/admin/settings", {
      method: "PATCH",
      body: { registration: { policy: policy.value, allowedDomains } },
    });
    await refresh();
    registrationMessage.value = "Saved.";
  } catch (err: unknown) {
    registrationError.value =
      (err as { statusMessage?: string })?.statusMessage ??
      (err instanceof Error ? err.message : "could not save");
  } finally {
    savingRegistration.value = false;
  }
}

async function saveAdmins() {
  savingAdmins.value = true;
  adminsMessage.value = null;
  adminsError.value = null;
  try {
    const emails = adminEmailsText.value
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    await $fetch("/api/admin/settings", {
      method: "PATCH",
      body: { platformAdmins: { emails } },
    });
    await refresh();
    adminsMessage.value = "Saved. Users get the flag on their next request.";
  } catch (err: unknown) {
    adminsError.value =
      (err as { statusMessage?: string })?.statusMessage ??
      (err instanceof Error ? err.message : "could not save");
  } finally {
    savingAdmins.value = false;
  }
}
</script>

<template>
  <div class="space-y-10">
    <section>
      <h1 class="text-2xl font-semibold">Self-registration policy</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        Controls whether new users can sign in to specifyr after authenticating
        with the IDP. Existing users are never blocked by these rules.
      </p>

      <form class="mt-6 max-w-xl space-y-4 rounded-lg border border-border bg-muted/30 p-4" @submit.prevent="saveRegistration">
        <div>
          <label class="text-sm font-medium">Policy</label>
          <select
            v-model="policy"
            class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            :disabled="savingRegistration"
          >
            <option value="open">Open — anyone with an IDP account can sign in</option>
            <option value="domain">Domain-restricted — only allowed email domains</option>
            <option value="closed">Closed — only invited users can sign in</option>
          </select>
        </div>

        <div v-if="policy === 'domain'">
          <label class="text-sm font-medium">Allowed email domains</label>
          <textarea
            v-model="domainsText"
            rows="4"
            class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
            placeholder="example.com&#10;another.org"
            :disabled="savingRegistration"
          />
          <p class="mt-1 text-xs text-muted-foreground">
            One per line, comma- or whitespace-separated. Lower-cased on save.
          </p>
        </div>

        <div class="flex items-center gap-3">
          <Button type="submit" :disabled="savingRegistration">
            {{ savingRegistration ? "Saving…" : "Save registration" }}
          </Button>
          <span v-if="registrationMessage" class="text-sm text-primary">{{ registrationMessage }}</span>
          <span v-if="registrationError" class="text-sm text-destructive">{{ registrationError }}</span>
        </div>
      </form>

      <p class="mt-3 text-xs text-muted-foreground">
        Invite-flow accepts ignore this policy by design — an org admin can
        onboard external collaborators even when the platform is "closed".
      </p>
    </section>

    <section>
      <h2 class="text-xl font-semibold">Platform admins</h2>
      <p class="mt-1 text-sm text-muted-foreground">
        Users with these emails get the platform-admin flag on their next
        request. The flag enables this <code class="font-mono text-xs">/admin</code>
        section. Existing users see it on their next page load; new users get
        it on first sign-in.
      </p>

      <form class="mt-6 max-w-xl space-y-4 rounded-lg border border-border bg-muted/30 p-4" @submit.prevent="saveAdmins">
        <div>
          <label class="text-sm font-medium">Additional admin emails</label>
          <textarea
            v-model="adminEmailsText"
            rows="5"
            class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
            placeholder="alice@example.com&#10;bob@example.com"
            :disabled="savingAdmins"
          />
          <p class="mt-1 text-xs text-muted-foreground">
            One per line, comma- or whitespace-separated. Lower-cased + de-duplicated on save.
          </p>
        </div>

        <div class="flex items-center gap-3">
          <Button type="submit" :disabled="savingAdmins">
            {{ savingAdmins ? "Saving…" : "Save admin emails" }}
          </Button>
          <span v-if="adminsMessage" class="text-sm text-primary">{{ adminsMessage }}</span>
          <span v-if="adminsError" class="text-sm text-destructive">{{ adminsError }}</span>
        </div>
      </form>

      <div v-if="data.platformAdmins.envEmails.length" class="mt-4 max-w-xl rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
        <div class="font-medium text-muted-foreground">
          Bootstrap admins (from <code class="font-mono">SPECIFYR_PLATFORM_ADMIN_EMAILS</code>)
        </div>
        <ul class="mt-1 space-y-0.5 font-mono text-muted-foreground">
          <li v-for="e in data.platformAdmins.envEmails" :key="e">{{ e }}</li>
        </ul>
        <p class="mt-2 text-muted-foreground">
          These are managed via the env var and cannot be revoked here — keep at least one to avoid locking yourself out.
        </p>
      </div>
    </section>
  </div>
</template>
