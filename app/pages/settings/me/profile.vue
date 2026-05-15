<script setup lang="ts">
import { ExternalLink, KeyRound, User as UserIcon } from "lucide-vue-next";
import { Button } from "~/components/shadcn/button";
import { Input } from "~/components/shadcn/input";

const { me, refresh } = useMe();
const { locales: i18nLocales } = useI18n();
const config = useRuntimeConfig();

const localeOptions = computed(() =>
  (i18nLocales.value as Array<{ code: string; name?: string }>).map((l) => ({
    code: l.code,
    label: l.name ?? l.code,
  })),
);

const displayName = ref<string>("");
const initialDisplayName = ref<string>("");
// "" represents "use the IDP/browser default" (DB null).
const preferredLocale = ref<string>("");
const initialPreferredLocale = ref<string>("");

watchEffect(() => {
  const dn = me.value?.displayName ?? "";
  displayName.value = dn;
  initialDisplayName.value = dn;
  const loc = me.value?.preferredLocale ?? "";
  preferredLocale.value = loc;
  initialPreferredLocale.value = loc;
});

const saving = ref(false);
const error = ref<string | null>(null);
const saved = ref(false);

const dirty = computed(
  () =>
    displayName.value.trim() !== initialDisplayName.value ||
    preferredLocale.value !== initialPreferredLocale.value,
);

const authHost = computed(
  () => (config.public.authHost as string | undefined) ?? "",
);
// Authentik exposes account self-service (including "Change password")
// at /if/user/. Hidden in dev mode (no IDP wired up).
const passwordChangeUrl = computed(() =>
  authHost.value ? `${authHost.value}/if/user/` : "",
);

async function save() {
  if (!dirty.value) return;
  saving.value = true;
  error.value = null;
  saved.value = false;
  try {
    await $fetch("/api/me", {
      method: "PATCH",
      body: {
        displayName: displayName.value,
        // Empty string = "no preference" → null in DB.
        preferredLocale: preferredLocale.value || null,
      },
    });
    await refresh();
    saved.value = true;
    setTimeout(() => (saved.value = false), 2000);
  } catch (err: unknown) {
    error.value =
      (err as { statusMessage?: string })?.statusMessage ??
      (err instanceof Error ? err.message : "could not save");
  } finally {
    saving.value = false;
  }
}

function reset() {
  displayName.value = initialDisplayName.value;
  preferredLocale.value = initialPreferredLocale.value;
  error.value = null;
  saved.value = false;
}
</script>

<template>
  <div>
    <NuxtLink
      to="/settings"
      class="text-xs text-muted-foreground hover:text-foreground"
    >
      ← Settings
    </NuxtLink>

    <h1 class="mt-2 flex items-center gap-2 text-2xl font-semibold">
      <UserIcon class="size-6 opacity-80" />
      Profile
    </h1>
    <p class="mt-1 text-sm text-muted-foreground">
      Your display name is shown to other members of your organizations.
      Your email and password are managed by the identity provider.
    </p>

    <form
      class="mt-8 max-w-xl space-y-6"
      @submit.prevent="save"
    >
      <div>
        <label class="block text-sm font-medium">Email</label>
        <p class="mt-1 font-mono text-sm text-muted-foreground">
          {{ me?.email ?? "—" }}
        </p>
      </div>

      <div>
        <label for="display-name" class="block text-sm font-medium">
          Display name
        </label>
        <Input
          id="display-name"
          v-model="displayName"
          type="text"
          maxlength="120"
          placeholder="e.g. Jane Doe"
          class="mt-1"
          :disabled="saving"
        />
        <p class="mt-1 text-xs text-muted-foreground">
          Leave empty to fall back to the name from your identity provider.
        </p>
      </div>

      <div>
        <label for="preferred-locale" class="block text-sm font-medium">
          Language
        </label>
        <select
          id="preferred-locale"
          v-model="preferredLocale"
          class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          :disabled="saving"
        >
          <option value="">Use browser default</option>
          <option
            v-for="opt in localeOptions"
            :key="opt.code"
            :value="opt.code"
          >
            {{ opt.label }}
          </option>
        </select>
        <p class="mt-1 text-xs text-muted-foreground">
          The English translation is incomplete — untranslated labels fall
          back to German.
        </p>
      </div>

      <div class="flex items-center gap-2">
        <Button type="submit" :disabled="!dirty || saving">
          {{ saving ? "Saving…" : "Save" }}
        </Button>
        <Button
          v-if="dirty"
          type="button"
          variant="outline"
          :disabled="saving"
          @click="reset"
        >
          Reset
        </Button>
        <span v-if="saved" class="text-sm text-muted-foreground">Saved.</span>
      </div>

      <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
    </form>

    <section class="mt-10 max-w-xl">
      <h2 class="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <KeyRound class="size-4" /> Password
      </h2>
      <div class="mt-3 rounded-lg border border-border bg-muted/30 p-4">
        <p class="text-sm">
          Passwords are managed by the identity provider, not by specifyr.
        </p>
        <a
          v-if="passwordChangeUrl"
          :href="passwordChangeUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="mt-3 inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent"
        >
          Change password <ExternalLink class="size-3.5 opacity-70" />
        </a>
        <p v-else class="mt-2 text-xs text-muted-foreground">
          No IDP is configured in this deployment (dev mode).
        </p>
      </div>
    </section>
  </div>
</template>
