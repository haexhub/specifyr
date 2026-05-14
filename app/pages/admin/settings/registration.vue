<script setup lang="ts">
import { Trash2 } from "lucide-vue-next";
import { Button } from "~/components/shadcn/button";
import ConfirmDialog from "~/components/ui/ConfirmDialog.vue";

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

const { data: me } = await useFetch<{ email?: string } | null>("/api/me", {
  default: () => null,
});

const policy = ref<Policy>(data.value.registration.policy);
const domainsText = ref(data.value.registration.allowedDomains.join("\n"));

const savingRegistration = ref(false);
const registrationMessage = ref<string | null>(null);
const registrationError = ref<string | null>(null);

watch(data, (d) => {
  if (!d) return;
  policy.value = d.registration.policy;
  domainsText.value = d.registration.allowedDomains.join("\n");
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

const newAdminEmail = ref("");
const addingAdmin = ref(false);
const adminsError = ref<string | null>(null);
const adminsMessage = ref<string | null>(null);
const emailToRemove = ref<string | null>(null);
const removingAdmin = ref(false);

const adminEmails = computed(() => data.value.platformAdmins.emails);

async function patchAdminEmails(next: string[]) {
  const normalized = Array.from(
    new Set(next.map((e) => e.trim().toLowerCase()).filter(Boolean)),
  );
  await $fetch("/api/admin/settings", {
    method: "PATCH",
    body: { platformAdmins: { emails: normalized } },
  });
  await refresh();
}

async function addAdminEmail() {
  const email = newAdminEmail.value.trim().toLowerCase();
  adminsError.value = null;
  adminsMessage.value = null;
  if (!email) return;
  if (!email.includes("@")) {
    adminsError.value = "Enter a valid email address.";
    return;
  }
  if (adminEmails.value.includes(email)) {
    adminsError.value = "That email is already an admin.";
    return;
  }
  addingAdmin.value = true;
  try {
    await patchAdminEmails([...adminEmails.value, email]);
    newAdminEmail.value = "";
    adminsMessage.value = `Added ${email}.`;
  } catch (err: unknown) {
    adminsError.value =
      (err as { statusMessage?: string })?.statusMessage ??
      (err instanceof Error ? err.message : "could not add");
  } finally {
    addingAdmin.value = false;
  }
}

function askRemoveAdmin(email: string) {
  adminsError.value = null;
  adminsMessage.value = null;
  emailToRemove.value = email;
}

async function confirmRemoveAdmin() {
  const email = emailToRemove.value;
  if (!email) return;
  removingAdmin.value = true;
  adminsError.value = null;
  try {
    await patchAdminEmails(adminEmails.value.filter((e) => e !== email));
    emailToRemove.value = null;
    adminsMessage.value = `Revoked ${email}.`;
  } catch (err: unknown) {
    adminsError.value =
      (err as { statusMessage?: string })?.statusMessage ??
      (err instanceof Error ? err.message : "could not revoke");
  } finally {
    removingAdmin.value = false;
  }
}

function cancelRemoveAdmin() {
  if (removingAdmin.value) return;
  emailToRemove.value = null;
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
        request. The flag unlocks this <code class="font-mono text-xs">/admin</code>
        section.
      </p>

      <div class="mt-6 max-w-xl rounded-lg border border-border bg-muted/30 p-4">
        <div class="text-sm font-medium">Additional admin emails</div>

        <ul v-if="adminEmails.length" class="mt-3 divide-y divide-border rounded-md border border-border bg-background">
          <li
            v-for="email in adminEmails"
            :key="email"
            class="flex items-center justify-between gap-3 px-3 py-2"
          >
            <span class="truncate font-mono text-sm">{{ email }}</span>
            <Button
              variant="outline"
              size="sm"
              class="text-destructive hover:bg-destructive/10 hover:text-destructive"
              :disabled="email === me?.email"
              :title="email === me?.email ? 'Cannot revoke yourself' : 'Revoke admin'"
              @click="askRemoveAdmin(email)"
            >
              <Trash2 class="size-3.5" />
              <span class="sr-only">Revoke</span>
            </Button>
          </li>
        </ul>
        <p v-else class="mt-3 text-sm text-muted-foreground">
          No additional admins. Add one below.
        </p>

        <form class="mt-4 flex flex-wrap items-center gap-2" @submit.prevent="addAdminEmail">
          <input
            v-model="newAdminEmail"
            type="email"
            placeholder="alice@example.com"
            class="flex-1 min-w-[16rem] rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
            :disabled="addingAdmin"
          />
          <Button type="submit" :disabled="addingAdmin || !newAdminEmail.trim()">
            {{ addingAdmin ? "Adding…" : "Add admin" }}
          </Button>
        </form>

        <p v-if="adminsMessage" class="mt-3 text-sm text-primary">{{ adminsMessage }}</p>
        <p v-if="adminsError" class="mt-3 text-sm text-destructive">{{ adminsError }}</p>
      </div>

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

    <ConfirmDialog
      :open="emailToRemove !== null"
      title="Revoke platform admin?"
      :message="emailToRemove ? `${emailToRemove} will lose platform-admin access on their next request.` : ''"
      details="They can be re-added at any time. Env-listed bootstrap admins are unaffected."
      confirm-label="Revoke"
      destructive
      :busy="removingAdmin"
      @confirm="confirmRemoveAdmin"
      @cancel="cancelRemoveAdmin"
      @update:open="(v) => { if (!v) cancelRemoveAdmin(); }"
    />
  </div>
</template>
