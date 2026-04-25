<script setup lang="ts">
import { Puzzle, Trash2, AlertCircle, CheckCircle2, Plus, RefreshCw } from "lucide-vue-next";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import ConfirmDialog from "~/components/ConfirmDialog.vue";

interface ExtensionInstallRecord {
  slug: string;
  installedAt: string;
  source: "auto" | "manual";
  status: "installed" | "failed";
  message?: string;
}

const props = defineProps<{
  slug: string;
}>();

const { data: manifest, refresh, pending } = await useFetch<{
  slug: string;
  extensions: ExtensionInstallRecord[];
  updatedAt: string | null;
}>(() => `/api/projects/${props.slug}/extensions`, {
  default: () => ({ slug: "", extensions: [], updatedAt: null }),
  key: () => `extensions-${props.slug}`
});

const { data: standards, refresh: refreshStandards } = await useFetch<{ extensions: string[] }>(
  "/api/config/standard-extensions",
  { default: () => ({ extensions: [] }), key: "standard-extensions" }
);

// Standards that aren't yet installed in this project. Empty set ⇒ nothing to sync.
const missingStandards = computed(() => {
  const installed = new Set(
    (manifest.value?.extensions ?? []).filter((e) => e.status === "installed").map((e) => e.slug)
  );
  return (standards.value?.extensions ?? []).filter((s) => !installed.has(s));
});

const removeTarget = ref<ExtensionInstallRecord | null>(null);
const removing = ref(false);
const syncing = ref(false);

async function syncStandards() {
  if (syncing.value || missingStandards.value.length === 0) return;
  syncing.value = true;
  try {
    await $fetch(`/api/projects/${props.slug}/extensions`, {
      method: "POST",
      body: { slugs: missingStandards.value, source: "auto" }
    });
    await Promise.all([refresh(), refreshStandards()]);
  } catch (err) {
    alert(err instanceof Error ? err.message : "Sync fehlgeschlagen.");
  } finally {
    syncing.value = false;
  }
}

async function confirmRemove() {
  const target = removeTarget.value;
  if (!target || removing.value) return;
  removing.value = true;
  try {
    await $fetch(`/api/projects/${props.slug}/extensions/${encodeURIComponent(target.slug)}`, {
      method: "DELETE"
    });
    removeTarget.value = null;
    await refresh();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Entfernen fehlgeschlagen.");
  } finally {
    removing.value = false;
  }
}
</script>

<template>
  <Card>
    <CardHeader>
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <Puzzle class="size-4 text-primary" />
          <CardTitle class="text-base">Installierte Extensions</CardTitle>
        </div>
        <div class="flex items-center gap-3">
          <Button
            v-if="missingStandards.length"
            variant="outline"
            size="sm"
            class="h-auto px-2 py-1 text-xs"
            :disabled="syncing"
            @click="syncStandards"
          >
            <RefreshCw class="mr-1 size-3" :class="syncing && 'animate-spin'" />
            Standards synchronisieren ({{ missingStandards.length }})
          </Button>
          <NuxtLink to="/extensions" class="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            Katalog →
          </NuxtLink>
        </div>
      </div>
    </CardHeader>
    <CardContent>
      <p v-if="pending" class="text-xs text-muted-foreground">Lade…</p>
      <p v-else-if="!manifest?.extensions.length" class="text-xs text-muted-foreground">
        Keine Extensions in diesem Projekt installiert.
        <NuxtLink to="/extensions" class="ml-1 inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground">
          <Plus class="size-3" /> Hinzufügen
        </NuxtLink>
      </p>
      <ul v-else class="divide-y divide-border/60">
        <li
          v-for="ext in manifest.extensions"
          :key="ext.slug"
          class="relative flex items-start gap-3 py-2.5 transition hover:bg-muted/20 focus-within:bg-muted/20"
        >
          <!-- Stretched link: row opens the extension detail page -->
          <NuxtLink
            :to="`/extensions/${ext.slug}`"
            class="absolute inset-0 focus:outline-none"
            :aria-label="`Details zu ${ext.slug}`"
          />
          <span class="mt-0.5 shrink-0">
            <CheckCircle2 v-if="ext.status === 'installed'" class="size-4 text-emerald-600" />
            <AlertCircle v-else class="size-4 text-destructive" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-baseline gap-2">
              <code class="truncate font-mono text-sm">{{ ext.slug }}</code>
              <Badge v-if="ext.source === 'auto'" variant="secondary" class="text-[10px]">auto</Badge>
              <Badge v-if="ext.status === 'failed'" variant="outline" class="text-[10px] text-destructive">fehlgeschlagen</Badge>
            </div>
            <p v-if="ext.message" class="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{{ ext.message }}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            class="relative z-10 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            @click.stop="removeTarget = ext"
          >
            <Trash2 class="size-3.5" />
          </Button>
        </li>
      </ul>
    </CardContent>

    <ConfirmDialog
      :open="removeTarget !== null"
      :title="`Extension '${removeTarget?.slug ?? ''}' entfernen?`"
      message="Entfernt die Extension aus diesem Projekt. Läuft `specify extension remove <slug>` und passt den lokalen Manifest an."
      confirm-label="Entfernen"
      destructive
      :busy="removing"
      @confirm="confirmRemove"
      @cancel="removeTarget = null"
    />
  </Card>
</template>
