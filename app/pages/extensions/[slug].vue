<script setup lang="ts">
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";
import {
  ArrowLeft,
  Star,
  ExternalLink,
  Download,
  BookOpen,
  GitBranch,
  FolderPlus,
  FolderGit2,
  Check
} from "lucide-vue-next";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from "~/components/ui/command";
import type { ProjectListItem } from "~/lib/types";

interface CatalogExtensionDetail {
  id: string;
  name: string;
  description?: string;
  author?: string;
  version?: string;
  tags?: string[];
  download_url?: string;
  homepage?: string;
  repository?: string;
  documentation?: string;
  changelog?: string;
  license?: string;
  verified?: boolean;
  downloads?: number;
  stars?: number;
  requires?: { speckit_version?: string };
  provides?: { commands?: number; hooks?: number };
  releasePublishedAt?: string;
}

interface ExtensionCommand {
  name: string;
  file?: string;
  description?: string;
  aliases?: string[];
}

interface ExtensionHook {
  event: string;
  command: string;
  description?: string;
  optional?: boolean;
  prompt?: string;
}

interface ExtensionDetailPayload {
  extension: CatalogExtensionDetail;
  dependents: { id: string; name?: string; version?: string }[];
  readmeContent: string;
  source?: "local" | "catalog";
  localPath?: string;
  commands?: ExtensionCommand[];
  hooks?: ExtensionHook[];
}

interface ProjectExtensionsManifest {
  slug: string;
  extensions: { slug: string; status: "installed" | "failed" }[];
  updatedAt: string | null;
}

const route = useRoute();
const slug = computed(() => String(route.params.slug ?? ""));

const { data, error, pending } = await useFetch<ExtensionDetailPayload>(
  () => `/api/extensions/${encodeURIComponent(slug.value)}`,
  { key: () => `extension-detail-${slug.value}` }
);

const { data: standardData, refresh: refreshStandard } = await useFetch<{ extensions: string[] }>(
  "/api/config/standard-extensions",
  { default: () => ({ extensions: [] }), key: "standard-extensions" }
);

const { data: projects, refresh: refreshProjects } = await useFetch<ProjectListItem[]>(
  "/api/projects",
  { default: () => [], key: "projects-list" }
);

const saving = ref(false);
const standardList = computed(() => standardData.value?.extensions ?? []);
const isStandard = computed(() => standardList.value.includes(slug.value));

const readmeHtml = computed(() => {
  const source = data.value?.readmeContent ?? "";
  if (!source) return "";
  const raw = marked.parse(source, { async: false, gfm: true, breaks: false }) as string;
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
});

const installedIn = ref<Set<string>>(new Set());
const installedLoaded = ref(false);

async function refreshInstalledMap() {
  installedLoaded.value = false;
  const entries = await Promise.all(
    (projects.value ?? []).map(async (p) => {
      try {
        const m = await $fetch<ProjectExtensionsManifest>(`/api/projects/${encodeURIComponent(p.slug)}/extensions`);
        const has = m.extensions.some((e) => e.slug === slug.value && e.status === "installed");
        return [p.slug, has] as const;
      } catch {
        return [p.slug, false] as const;
      }
    })
  );
  installedIn.value = new Set(entries.filter(([, has]) => has).map(([s]) => s));
  installedLoaded.value = true;
}

watch([projects, slug], () => refreshInstalledMap(), { immediate: true });

const pickerOpen = ref(false);
const selectedProjectSlugs = ref<Set<string>>(new Set());

function toggleProject(projectSlug: string) {
  const next = new Set(selectedProjectSlugs.value);
  if (next.has(projectSlug)) next.delete(projectSlug);
  else next.add(projectSlug);
  selectedProjectSlugs.value = next;
}

async function addToStandard() {
  if (isStandard.value) return;
  saving.value = true;
  try {
    await $fetch("/api/config/standard-extensions", {
      method: "POST",
      body: { extensions: [...standardList.value, slug.value] }
    });
    await refreshStandard();
  } finally {
    saving.value = false;
  }
}

async function installIntoSelectedProjects() {
  if (selectedProjectSlugs.value.size === 0) return;
  saving.value = true;
  try {
    const targets = Array.from(selectedProjectSlugs.value);
    await Promise.all(
      targets.map((projectSlug) =>
        $fetch(`/api/projects/${encodeURIComponent(projectSlug)}/extensions`, {
          method: "POST",
          body: { slug: slug.value, source: "manual" }
        })
      )
    );
    selectedProjectSlugs.value = new Set();
    pickerOpen.value = false;
    await refreshInstalledMap();
    await refreshProjects();
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="h-dvh overflow-y-auto p-6 lg:p-10">
    <div class="mx-auto w-full max-w-4xl space-y-4">
      <NuxtLink to="/extensions" class="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft class="size-4" />
        {{ $t("extensions.detail.backToCatalog") }}
      </NuxtLink>

      <div v-if="pending" class="text-sm text-muted-foreground">{{ $t("extensions.detail.loading") }}</div>
      <div v-else-if="error" class="text-sm text-destructive">
        {{ $t("extensions.detail.loadError") }} {{ error.message }}
      </div>
      <template v-else-if="data">
        <header class="space-y-3 border-b border-border/60 pb-4">
          <div class="flex flex-wrap items-baseline gap-2">
            <h1 class="text-2xl font-semibold tracking-tight">{{ data.extension.name }}</h1>
            <code class="font-mono text-xs text-muted-foreground">{{ data.extension.id }}</code>
            <Badge v-if="data.extension.version" variant="outline">v{{ data.extension.version }}</Badge>
            <Badge v-if="data.source === 'local'" variant="secondary" class="gap-1">
              <FolderGit2 class="size-3" />
              {{ $t("extensions.detail.local") }}
            </Badge>
            <Badge v-if="data.extension.verified" variant="secondary">verified</Badge>
          </div>
          <p v-if="data.extension.description" class="text-sm text-muted-foreground">
            {{ data.extension.description }}
          </p>
          <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span v-if="data.extension.author">
              {{ $t("extensions.detail.by") }} <span class="font-medium text-foreground">{{ data.extension.author }}</span>
            </span>
            <span v-if="data.extension.license">{{ data.extension.license }}</span>
            <span v-if="data.extension.requires?.speckit_version">
              spec-kit {{ data.extension.requires.speckit_version }}
            </span>
            <span v-if="data.extension.provides">
              {{ data.extension.provides.commands ?? 0 }} Commands · {{ data.extension.provides.hooks ?? 0 }} Hooks
            </span>
            <span v-if="data.extension.stars">★ {{ data.extension.stars }}</span>
          </div>
          <p v-if="data.localPath" class="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <FolderGit2 class="size-3" />
            <span class="truncate" :title="data.localPath">{{ data.localPath }}</span>
          </p>
          <div class="flex flex-wrap gap-2">
            <Button
              v-if="data.extension.repository"
              as="a"
              variant="outline"
              size="sm"
              :href="data.extension.repository"
              target="_blank"
              rel="noopener"
            >
              <GitBranch class="mr-1.5 size-3.5" />
              Repository
              <ExternalLink class="ml-1.5 size-3" />
            </Button>
            <Button
              v-if="data.extension.documentation"
              as="a"
              variant="outline"
              size="sm"
              :href="data.extension.documentation"
              target="_blank"
              rel="noopener"
            >
              <BookOpen class="mr-1.5 size-3.5" />
              Docs
              <ExternalLink class="ml-1.5 size-3" />
            </Button>
            <Button
              v-if="data.extension.download_url"
              as="a"
              variant="outline"
              size="sm"
              :href="data.extension.download_url"
              target="_blank"
              rel="noopener"
            >
              <Download class="mr-1.5 size-3.5" />
              Download
            </Button>
            <Button v-if="!isStandard" variant="outline" size="sm" :disabled="saving" @click="addToStandard">
              <Star class="mr-1.5 size-3.5" />
              {{ $t("extensions.detail.addToFavorites") }}
            </Button>
            <Badge v-else variant="secondary">{{ $t("extensions.detail.inFavorites") }}</Badge>

            <Popover v-model:open="pickerOpen">
              <PopoverTrigger as-child>
                <Button size="sm" :disabled="saving || !(projects ?? []).length">
                  <FolderPlus class="mr-1.5 size-3.5" />
                  {{ $t("extensions.detail.addToProjects") }}
                </Button>
              </PopoverTrigger>
              <PopoverContent class="w-80 p-0" align="start">
                <Command>
                  <CommandInput :placeholder="$t('extensions.detail.searchProject')" />
                  <CommandEmpty>{{ $t("extensions.detail.noProjectsFound") }}</CommandEmpty>
                  <CommandList class="max-h-72">
                    <CommandGroup>
                      <CommandItem
                        v-for="p in projects ?? []"
                        :key="p.slug"
                        :value="`${p.slug} ${p.title}`"
                        :disabled="installedIn.has(p.slug)"
                        class="flex items-center gap-2"
                        @select="toggleProject(p.slug)"
                      >
                        <div
                          class="flex size-4 shrink-0 items-center justify-center rounded border border-input"
                          :class="
                            installedIn.has(p.slug)
                              ? 'bg-muted'
                              : selectedProjectSlugs.has(p.slug)
                                ? 'border-primary bg-primary text-primary-foreground'
                                : ''
                          "
                        >
                          <Check
                            v-if="selectedProjectSlugs.has(p.slug) || installedIn.has(p.slug)"
                            class="size-3"
                          />
                        </div>
                        <div class="min-w-0 flex-1">
                          <div class="truncate text-sm">{{ p.title || p.slug }}</div>
                          <div class="truncate text-[11px] text-muted-foreground">
                            {{ installedIn.has(p.slug) ? $t("extensions.detail.alreadyInstalled") : p.slug }}
                          </div>
                        </div>
                      </CommandItem>
                    </CommandGroup>
                  </CommandList>
                  <div class="flex items-center justify-between gap-2 border-t border-border/60 px-2 py-2">
                    <span class="text-xs text-muted-foreground">
                      {{ $t("extensions.detail.selectedCount", { count: selectedProjectSlugs.size }) }}
                    </span>
                    <Button
                      size="sm"
                      :disabled="saving || selectedProjectSlugs.size === 0"
                      @click="installIntoSelectedProjects"
                    >
                      {{ $t("extensions.detail.install") }}
                    </Button>
                  </div>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
          <div v-if="installedLoaded && installedIn.size" class="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <span>{{ $t("extensions.detail.installedIn") }}</span>
            <Badge v-for="s in Array.from(installedIn)" :key="s" variant="secondary">{{ s }}</Badge>
          </div>
          <div v-if="data.extension.tags?.length" class="flex flex-wrap gap-1">
            <span
              v-for="tag in data.extension.tags"
              :key="tag"
              class="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
            >
              {{ tag }}
            </span>
          </div>
        </header>

        <section v-if="data.commands?.length" class="rounded-md border border-border/60 bg-card">
          <h3 class="border-b border-border/60 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {{ $t("extensions.detail.commandsTitle", { count: data.commands.length }) }}
          </h3>
          <ul class="divide-y divide-border/60">
            <li v-for="cmd in data.commands" :key="cmd.name" class="px-4 py-2.5">
              <code class="font-mono text-sm text-foreground">/{{ cmd.name }}</code>
              <p v-if="cmd.description" class="mt-1 text-xs text-muted-foreground">
                {{ cmd.description }}
              </p>
              <p v-if="cmd.aliases?.length" class="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                <span>{{ $t("extensions.detail.aliases") }}</span>
                <code v-for="alias in cmd.aliases" :key="alias" class="font-mono">/{{ alias }}</code>
              </p>
            </li>
          </ul>
        </section>

        <section v-if="data.hooks?.length" class="rounded-md border border-border/60 bg-card">
          <h3 class="border-b border-border/60 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {{ $t("extensions.detail.hooksTitle", { count: data.hooks.length }) }}
          </h3>
          <p class="border-b border-border/60 bg-muted/20 px-4 py-1.5 text-[11px] text-muted-foreground">
            {{ $t("extensions.detail.hooksDescPre") }}<Badge variant="outline" class="text-[10px]">optional</Badge>{{ $t("extensions.detail.hooksDescPost") }}
          </p>
          <ul class="divide-y divide-border/60">
            <li v-for="hook in data.hooks" :key="`${hook.event}::${hook.command}`" class="px-4 py-2.5">
              <div class="flex flex-wrap items-baseline gap-2">
                <code class="font-mono text-sm text-primary">{{ hook.event }}</code>
                <span class="text-muted-foreground">→</span>
                <code class="font-mono text-sm text-foreground">/{{ hook.command }}</code>
                <Badge v-if="hook.optional" variant="outline" class="text-[10px]">optional</Badge>
              </div>
              <p v-if="hook.description" class="mt-1 text-xs text-muted-foreground">
                {{ hook.description }}
              </p>
              <p v-if="hook.optional && hook.prompt" class="mt-1 text-[11px] italic text-muted-foreground">
                {{ $t("extensions.detail.prompt", { prompt: hook.prompt }) }}
              </p>
            </li>
          </ul>
        </section>

        <section class="rounded-md border border-border/60 bg-card">
          <h3 class="border-b border-border/60 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {{ $t("extensions.detail.readmeTitle") }}
          </h3>
          <article
            v-if="readmeHtml"
            class="prose prose-sm max-w-none px-4 py-4 prose-headings:text-foreground prose-a:text-primary prose-code:text-foreground prose-pre:bg-muted prose-pre:text-foreground"
            v-html="readmeHtml"
          />
          <p v-else class="px-4 py-4 text-sm text-muted-foreground">{{ $t("extensions.detail.noReadme") }}</p>
        </section>

        <div v-if="data.dependents?.length" class="text-xs text-muted-foreground">
          {{ $t("extensions.detail.dependents") }}
          <span v-for="(dep, idx) in data.dependents" :key="dep.id">
            <code class="font-mono">{{ dep.id }}</code><span v-if="idx < data.dependents.length - 1">, </span>
          </span>
        </div>
      </template>
    </div>
  </div>
</template>
