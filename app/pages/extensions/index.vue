<script setup lang="ts">
import { Puzzle, Plus, Trash2, Star, RefreshCw, Check, ChevronsUpDown, Search, X, Filter, FolderGit2, FolderOpen } from "lucide-vue-next";
import { watchDebounced } from "@vueuse/core";
import { Button } from "~/components/shadcn/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/shadcn/card";
import { Badge } from "~/components/shadcn/badge";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/shadcn/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from "~/components/shadcn/command";

interface CatalogExtension {
  id: string;
  name: string;
  description?: string;
  author?: string;
  version?: string;
  tags?: string[];
}

interface CatalogResponse {
  meta?: { fetchedAt: number; buildId: string; count: number } | null;
  extensions: CatalogExtension[];
}

interface LocalExtensionMetadata {
  slug: string;
  path: string;
  registeredAt: string;
  name?: string;
  version?: string;
  description?: string;
  tags?: string[];
  commandCount?: number;
  hookCount?: number;
  error?: string;
}

const { t } = useI18n();

const { data: extData, refresh } = await useFetch<{ extensions: string[] }>(
  "/api/config/standard-extensions",
  { default: () => ({ extensions: [] }) }
);

const {
  data: catalogData,
  refresh: refreshCatalog,
  pending: catalogLoading,
  error: catalogError
} = await useFetch<CatalogResponse>("/api/extensions/catalog", {
  default: () => ({ extensions: [], meta: null })
});

const { data: localData, refresh: refreshLocal } = await useFetch<{ extensions: LocalExtensionMetadata[] }>(
  "/api/config/local-extensions",
  { default: () => ({ extensions: [] }) }
);

const localList = computed(() => localData.value?.extensions ?? []);

const pickerOpen = ref(false);
const localBusy = ref(false);
const localError = ref("");

const newSlug = ref("");
const saving = ref(false);
const errorMessage = ref("");
const comboboxOpen = ref(false);

const MAX_VISIBLE_TAGS = 4;

const standardList = computed(() => extData.value?.extensions ?? []);
const catalog = computed<CatalogExtension[]>(() => catalogData.value?.extensions ?? []);

const addableExtensions = computed(() => {
  const set = new Set(standardList.value);
  return catalog.value.filter((ext) => !set.has(ext.id));
});

const catalogBySlug = computed(() => {
  const map = new Map<string, CatalogExtension>();
  for (const ext of catalog.value) map.set(ext.id, ext);
  return map;
});

const route = useRoute();
const router = useRouter();

function readQueryString(v: unknown): string {
  return typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : "";
}
function readQueryTags(v: unknown): Set<string> {
  const raw = readQueryString(v);
  if (!raw) return new Set();
  return new Set(raw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean));
}

const searchQuery = ref(readQueryString(route.query.q));
const selectedTags = ref<Set<string>>(readQueryTags(route.query.tags));
const tagPickerOpen = ref(false);

function syncQueryToUrl(mode: "push" | "replace") {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(route.query)) {
    if (k === "q" || k === "tags") continue;
    if (typeof v === "string") next[k] = v;
  }
  const q = searchQuery.value.trim();
  if (q) next.q = q;
  if (selectedTags.value.size) next.tags = Array.from(selectedTags.value).join(",");
  const nav = mode === "push" ? router.push : router.replace;
  nav.call(router, { path: route.path, query: next });
}

watchDebounced(searchQuery, (next, prev) => {
  const hadQ = Boolean(String(prev ?? "").trim());
  const hasQ = Boolean(next.trim());
  syncQueryToUrl(hadQ === hasQ ? "replace" : "push");
}, { debounce: 250 });
watch(selectedTags, () => syncQueryToUrl("push"));

const tagCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const ext of catalog.value) {
    for (const tag of ext.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
});

const filteredCatalog = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  const tags = selectedTags.value;
  if (!q && tags.size === 0) return catalog.value;
  return catalog.value.filter((ext) => {
    if (tags.size > 0) {
      const extTags = new Set(ext.tags ?? []);
      let hit = false;
      for (const tag of tags) {
        if (extTags.has(tag)) { hit = true; break; }
      }
      if (!hit) return false;
    }
    if (q) {
      const hay = `${ext.id} ${ext.name} ${ext.description ?? ""} ${(ext.tags ?? []).join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
});

function toggleTag(tag: string) {
  const next = new Set(selectedTags.value);
  if (next.has(tag)) next.delete(tag);
  else next.add(tag);
  selectedTags.value = next;
}

function clearFilters() {
  searchQuery.value = "";
  selectedTags.value = new Set();
}

async function updateList(next: string[]) {
  saving.value = true;
  errorMessage.value = "";
  try {
    await $fetch("/api/config/standard-extensions", {
      method: "POST",
      body: { extensions: next }
    });
    await refresh();
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : t("extensions.index.saveFailed");
  } finally {
    saving.value = false;
  }
}

async function addStandardExtension() {
  const slug = newSlug.value.trim();
  if (!slug) return;
  const current = standardList.value;
  if (current.includes(slug)) {
    errorMessage.value = t("extensions.index.alreadyInList", { slug });
    return;
  }
  await updateList([...current, slug]);
  if (!errorMessage.value) newSlug.value = "";
}

function pickCatalogExtension(slug: string) {
  newSlug.value = slug;
  comboboxOpen.value = false;
}

async function removeStandardExtension(slug: string) {
  await updateList(standardList.value.filter((s) => s !== slug));
}

async function reloadCatalog() {
  await refreshCatalog();
}

function readErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === "string") return err;
  const asRecord = err as { data?: { statusMessage?: unknown }; statusMessage?: unknown; message?: unknown };
  return (
    (typeof asRecord?.data?.statusMessage === "string" && asRecord.data.statusMessage) ||
    (typeof asRecord?.statusMessage === "string" && asRecord.statusMessage) ||
    (typeof asRecord?.message === "string" && asRecord.message) ||
    fallback
  );
}

async function onPickerSelect(selectedPath: string) {
  localBusy.value = true;
  localError.value = "";
  try {
    await $fetch("/api/config/local-extensions", {
      method: "POST",
      body: { path: selectedPath }
    });
    await refreshLocal();
  } catch (err) {
    localError.value = readErrorMessage(err, t("extensions.index.registerFailed"));
  } finally {
    localBusy.value = false;
  }
}

async function unregisterLocalExtension(slug: string) {
  localBusy.value = true;
  localError.value = "";
  try {
    await $fetch(`/api/config/local-extensions/${encodeURIComponent(slug)}`, {
      method: "DELETE"
    });
    await Promise.all([refreshLocal(), refresh()]);
  } catch (err) {
    localError.value = readErrorMessage(err, t("extensions.index.removeFailed"));
  } finally {
    localBusy.value = false;
  }
}

</script>

<template>
  <div class="space-y-6">
    <header class="flex shrink-0 items-center gap-3">
        <div class="inline-flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Puzzle class="size-5" />
        </div>
        <div class="flex-1">
          <h1 class="text-2xl font-semibold tracking-tight">Extensions</h1>
          <p class="text-sm text-muted-foreground">
            {{ $t("extensions.index.subtitle") }}
          </p>
        </div>
        <Button variant="ghost" size="sm" :disabled="catalogLoading" @click="reloadCatalog">
          <RefreshCw class="mr-1.5 size-3.5" :class="catalogLoading && 'animate-spin'" />
          {{ $t("extensions.index.reloadCatalog") }}
        </Button>
      </header>

      <Card class="shrink-0">
        <CardHeader>
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2">
              <Star class="size-4 text-primary" />
              <CardTitle class="text-base">{{ $t("extensions.index.favoritesTitle") }}</CardTitle>
            </div>
            <span class="text-xs text-muted-foreground">
              {{ $t("extensions.index.favoritesActive", { count: standardList.length }) }}
              <template v-if="catalogData?.meta?.count">
                · {{ $t("extensions.index.favoritesInCatalog", { count: catalogData.meta.count }) }}
              </template>
            </span>
          </div>
          <p class="text-xs text-muted-foreground">
            {{ $t("extensions.index.favoritesDesc") }}
          </p>
        </CardHeader>
        <CardContent class="space-y-3">
          <ul v-if="standardList.length" class="divide-y divide-border rounded-md border border-border">
            <li
              v-for="slug in standardList"
              :key="slug"
              class="relative flex items-center justify-between gap-3 px-4 py-2.5 transition hover:bg-muted/20 focus-within:bg-muted/20"
            >
              <NuxtLink
                :to="`/extensions/${slug}`"
                class="absolute inset-0 focus:outline-none"
                :aria-label="$t('extensions.index.details', { name: slug })"
              />
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-baseline gap-2">
                  <span class="truncate font-medium">
                    {{ catalogBySlug.get(slug)?.name ?? slug }}
                  </span>
                  <code class="truncate font-mono text-xs text-muted-foreground">{{ slug }}</code>
                  <Badge v-if="catalogBySlug.get(slug)?.version" variant="outline">
                    v{{ catalogBySlug.get(slug)!.version }}
                  </Badge>
                </div>
                <p v-if="catalogBySlug.get(slug)?.description" class="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {{ catalogBySlug.get(slug)!.description }}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                class="relative z-10 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                :disabled="saving"
                @click.stop="removeStandardExtension(slug)"
              >
                <Trash2 class="mr-1.5 size-3.5" />
                {{ $t("common.remove") }}
              </Button>
            </li>
          </ul>
          <p v-else class="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            {{ $t("extensions.index.noFavorites") }}
          </p>

          <div class="space-y-2 pt-2">
            <label class="text-xs font-medium">{{ $t("extensions.index.addFromCatalog") }}</label>
            <form class="flex gap-2" @submit.prevent="addStandardExtension">
              <Popover v-model:open="comboboxOpen">
                <PopoverTrigger as-child>
                  <Button
                    variant="outline"
                    role="combobox"
                    :aria-expanded="comboboxOpen"
                    class="flex-1 justify-between font-mono"
                    :disabled="saving"
                  >
                    <span v-if="newSlug" class="truncate">
                      {{ catalogBySlug.get(newSlug)?.name ?? newSlug }}
                      <span class="ml-1 text-muted-foreground">{{ newSlug }}</span>
                    </span>
                    <span v-else class="text-muted-foreground">{{ $t("extensions.index.slugPlaceholder") }}</span>
                    <ChevronsUpDown class="ml-2 size-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent class="w-[--reka-popover-trigger-width] p-0" align="start">
                  <Command>
                    <CommandInput :placeholder="$t('extensions.index.comboboxSearchPlaceholder')" />
                    <CommandEmpty>{{ $t("extensions.index.comboboxEmpty") }}</CommandEmpty>
                    <CommandList class="max-h-72">
                      <CommandGroup>
                        <CommandItem
                          v-for="ext in addableExtensions"
                          :key="ext.id"
                          :value="`${ext.id} ${ext.name} ${ext.description ?? ''} ${(ext.tags ?? []).join(' ')}`"
                          class="flex items-start gap-2"
                          @select="pickCatalogExtension(ext.id)"
                        >
                          <Check
                            class="mt-1 size-4 shrink-0"
                            :class="newSlug === ext.id ? 'opacity-100' : 'opacity-0'"
                          />
                          <div class="min-w-0 flex-1">
                            <div class="flex flex-wrap items-baseline gap-1.5">
                              <span class="truncate text-sm font-medium">{{ ext.name }}</span>
                              <code class="font-mono text-[11px] text-muted-foreground">{{ ext.id }}</code>
                            </div>
                            <p v-if="ext.description" class="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                              {{ ext.description }}
                            </p>
                          </div>
                        </CommandItem>
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              <Button type="submit" :disabled="saving || !newSlug.trim()">
                <Plus class="mr-1.5 size-4" />
                {{ $t("extensions.index.addToFavorites") }}
              </Button>
            </form>
            <p v-if="catalogError" class="text-xs text-destructive">
              {{ $t("extensions.index.catalogLoadError") }}
            </p>
            <p v-else-if="catalogLoading" class="text-xs text-muted-foreground">
              {{ $t("extensions.index.catalogLoading") }}
            </p>
            <p v-else-if="addableExtensions.length" class="text-xs text-muted-foreground">
              {{ $t("extensions.index.addableCount", { count: addableExtensions.length }) }}
            </p>
          </div>

          <p v-if="errorMessage" class="text-sm text-destructive">{{ errorMessage }}</p>
        </CardContent>
      </Card>

      <Card class="shrink-0">
        <CardHeader>
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2">
              <FolderGit2 class="size-4 text-primary" />
              <CardTitle class="text-base">{{ $t("extensions.index.localTitle") }}</CardTitle>
            </div>
            <span class="text-xs text-muted-foreground">
              {{ $t("extensions.index.localRegistered", { count: localList.length }) }}
            </span>
          </div>
          <p class="text-xs text-muted-foreground">
            {{ $t("extensions.index.localDescPre") }} <code class="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">extension.yml</code>{{ $t("extensions.index.localDescMid") }} <code class="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">specify extension add --dev &lt;pfad&gt;</code>{{ $t("extensions.index.localDescEnd") }}
          </p>
        </CardHeader>
        <CardContent class="space-y-3">
          <ul v-if="localList.length" class="divide-y divide-border rounded-md border border-border">
            <li
              v-for="ext in localList"
              :key="ext.slug"
              class="relative flex items-center justify-between gap-3 px-4 py-2.5 transition hover:bg-muted/20 focus-within:bg-muted/20"
            >
              <NuxtLink
                v-if="!ext.error"
                :to="`/extensions/${ext.slug}`"
                class="absolute inset-0 focus:outline-none"
                :aria-label="$t('extensions.index.details', { name: ext.name ?? ext.slug })"
              />
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-baseline gap-2">
                  <span class="truncate font-medium">{{ ext.name ?? ext.slug }}</span>
                  <code class="truncate font-mono text-xs text-muted-foreground">{{ ext.slug }}</code>
                  <Badge v-if="ext.version && !ext.error" variant="outline">v{{ ext.version }}</Badge>
                  <Badge v-if="ext.error" variant="destructive">{{ $t("common.error") }}</Badge>
                </div>
                <p v-if="ext.description && !ext.error" class="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {{ ext.description }}
                </p>
                <p v-else-if="ext.error" class="mt-1 text-xs text-destructive">{{ ext.error }}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                class="relative z-10 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                :disabled="localBusy"
                @click.stop="unregisterLocalExtension(ext.slug)"
              >
                <Trash2 class="mr-1.5 size-3.5" />
                {{ $t("common.remove") }}
              </Button>
            </li>
          </ul>
          <p v-else class="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            {{ $t("extensions.index.noLocalExtensions") }}
          </p>

          <div class="pt-2">
            <Button :disabled="localBusy" @click="pickerOpen = true">
              <FolderOpen class="mr-1.5 size-4" />
              {{ $t("extensions.index.chooseFolder") }}
            </Button>
            <p v-if="localError" class="mt-2 text-xs text-destructive">{{ localError }}</p>
          </div>

          <SettingsLocalExtensionPicker v-model:open="pickerOpen" @select="onPickerSelect" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="text-base">{{ $t("extensions.index.communityTitle") }}</CardTitle>
          <p class="text-xs text-muted-foreground">
            {{ $t("extensions.index.communityDescPre") }} <code class="rounded bg-muted px-1 py-0.5 text-xs">speckit-community.github.io/extensions</code>{{ $t("extensions.index.communityDescPost") }}
          </p>
        </CardHeader>
        <CardContent class="space-y-3">
          <p v-if="catalogLoading" class="text-sm text-muted-foreground">{{ $t("extensions.index.communityLoading") }}</p>
          <p v-else-if="catalogError" class="text-sm text-destructive">
            {{ $t("extensions.index.communityError") }}
          </p>
          <p v-else-if="!catalog.length" class="text-sm text-muted-foreground">{{ $t("extensions.index.communityEmpty") }}</p>
          <template v-else>
            <div class="relative">
              <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                v-model="searchQuery"
                type="search"
                :placeholder="$t('extensions.index.searchPlaceholder')"
                class="w-full rounded-md border border-input bg-background py-2 pl-9 pr-9 text-sm outline-none ring-offset-background transition placeholder:text-muted-foreground focus:ring-2 focus:ring-ring focus:ring-offset-2"
              />
              <button
                v-if="searchQuery"
                type="button"
                class="absolute right-2 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                :aria-label="$t('extensions.index.clearSearch')"
                @click="searchQuery = ''"
              >
                <X class="size-3.5" />
              </button>
            </div>
            <div v-if="tagCounts.length" class="flex flex-wrap items-center gap-2">
              <Popover v-model:open="tagPickerOpen">
                <PopoverTrigger as-child>
                  <Button variant="outline" size="sm" class="h-auto gap-2 px-3 py-1.5 text-xs">
                    <Filter class="size-3.5" />
                    <span v-if="selectedTags.size === 0">{{ $t("extensions.index.filterTags") }}</span>
                    <span v-else>{{ $t("extensions.index.tagsActive", { count: selectedTags.size }) }}</span>
                    <ChevronsUpDown class="size-3 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent class="w-80 p-0" align="start">
                  <Command>
                    <CommandInput :placeholder="$t('extensions.index.tagSearch')" />
                    <CommandEmpty>{{ $t("extensions.index.noTagsFound") }}</CommandEmpty>
                    <CommandList class="max-h-80">
                      <CommandGroup>
                        <CommandItem
                          v-for="[tag, count] in tagCounts"
                          :key="tag"
                          :value="tag"
                          class="flex items-center gap-2"
                          @select="toggleTag(tag)"
                        >
                          <div
                            class="flex size-4 shrink-0 items-center justify-center rounded border border-input"
                            :class="selectedTags.has(tag) ? 'border-primary bg-primary text-primary-foreground' : ''"
                          >
                            <Check v-if="selectedTags.has(tag)" class="size-3" />
                          </div>
                          <span class="flex-1 truncate text-xs uppercase tracking-wider">{{ tag }}</span>
                          <span class="shrink-0 text-[10px] text-muted-foreground">{{ count }}</span>
                        </CommandItem>
                      </CommandGroup>
                    </CommandList>
                    <div
                      v-if="selectedTags.size"
                      class="flex items-center justify-between gap-2 border-t border-border/60 px-2 py-2"
                    >
                      <span class="text-[11px] text-muted-foreground">
                        {{ $t("extensions.index.selectedCount", { count: selectedTags.size }) }}
                      </span>
                      <button
                        type="button"
                        class="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        @click="selectedTags = new Set()"
                      >
                        {{ $t("extensions.index.clearSelection") }}
                      </button>
                    </div>
                  </Command>
                </PopoverContent>
              </Popover>

              <button
                v-for="tag in Array.from(selectedTags)"
                :key="tag"
                type="button"
                class="inline-flex items-center gap-1 rounded-full border border-primary bg-primary px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary-foreground transition hover:opacity-80"
                @click="toggleTag(tag)"
              >
                {{ tag }}
                <X class="size-3" />
              </button>
            </div>
            <div class="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                <template v-if="filteredCatalog.length !== catalog.length">
                  {{ $t("extensions.index.extensionCountFiltered", { shown: filteredCatalog.length, total: catalog.length }) }}
                </template>
                <template v-else>
                  {{ $t("extensions.index.extensionCountAll", { count: catalog.length }) }}
                </template>
                <template v-if="selectedTags.size"> · {{ $t("extensions.index.tagsActive", { count: selectedTags.size }) }}</template>
              </span>
              <button
                v-if="searchQuery || selectedTags.size"
                type="button"
                class="text-xs underline-offset-2 hover:text-foreground hover:underline"
                @click="clearFilters"
              >
                {{ $t("extensions.index.clearFilters") }}
              </button>
            </div>

            <p v-if="filteredCatalog.length === 0" class="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              {{ $t("extensions.index.noMatchingExtensions") }}
            </p>
            <div v-else class="grid gap-2 md:grid-cols-2">
              <div
                v-for="ext in filteredCatalog"
                :key="ext.id"
                class="relative flex h-full flex-col rounded-md border border-border/60 bg-muted/20 p-3 transition hover:border-primary/40 hover:bg-muted/40 focus-within:ring-2 focus-within:ring-ring"
              >
                <NuxtLink
                  :to="`/extensions/${ext.id}`"
                  class="absolute inset-0 rounded-md focus:outline-none"
                  :aria-label="$t('extensions.index.details', { name: ext.name })"
                />
                <div class="truncate text-sm font-medium">{{ ext.name }}</div>
                <div class="mt-0.5 flex items-center justify-between gap-2">
                  <code class="truncate font-mono text-[11px] text-muted-foreground">{{ ext.id }}</code>
                  <Badge v-if="ext.version" variant="outline" class="shrink-0">
                    v{{ ext.version }}
                  </Badge>
                </div>
                <p class="mt-1 line-clamp-2 min-h-8 text-xs text-muted-foreground">
                  {{ ext.description ?? "" }}
                </p>
                <div class="mt-2 flex min-h-5 flex-wrap gap-1">
                  <template v-if="ext.tags?.length">
                    <span
                      v-for="tag in ext.tags.slice(0, MAX_VISIBLE_TAGS)"
                      :key="tag"
                      class="rounded bg-background px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
                    >
                      {{ tag }}
                    </span>
                    <span
                      v-if="ext.tags.length > MAX_VISIBLE_TAGS"
                      class="rounded bg-background px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
                    >
                      +{{ ext.tags.length - MAX_VISIBLE_TAGS }}
                    </span>
                  </template>
                </div>
                <div class="relative z-10 mt-auto flex items-center justify-between gap-2 pt-3 text-[11px] text-muted-foreground">
                  <span class="truncate">{{ ext.author ?? t('extensions.index.community') }}</span>
                  <Button
                    v-if="!standardList.includes(ext.id)"
                    variant="ghost"
                    size="sm"
                    class="h-auto shrink-0 px-2 py-1 text-xs"
                    :disabled="saving"
                    @click="updateList([...standardList, ext.id])"
                  >
                    <Star class="mr-1 size-3" />
                    {{ $t("extensions.index.toFavorites") }}
                  </Button>
                  <Badge v-else variant="secondary" class="shrink-0">{{ $t("extensions.index.favoriteLabel") }}</Badge>
                </div>
              </div>
            </div>
          </template>
        </CardContent>
      </Card>
  </div>
</template>
