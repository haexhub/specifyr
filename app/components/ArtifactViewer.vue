<script setup lang="ts">
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";
import mermaid from "mermaid";
import { FileWarning, Loader2, RefreshCw, PanelRightClose, Wand2, X } from "lucide-vue-next";
import { Button } from "~/components/shadcn/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/shadcn/select";

interface ArtifactFile {
  type: "file";
  path: string;
  size: number;
  mtime: number;
  content: string;
}

interface DirectoryEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

interface ArtifactDir {
  type: "dir";
  path: string;
  entries: DirectoryEntry[];
}

const props = defineProps<{
  slug: string;
  candidates: string[];
  reloadToken?: number;
}>();

const emit = defineEmits<{
  collapse: [];
  powerPrompt: [prompt: string];
  artifactResolved: [];
}>();

const { t } = useI18n();

const powerMode = ref(false);
const selection = ref<{ text: string; anchorTop: number } | null>(null);
const changeInstruction = ref("");
const preRef = ref<HTMLElement | null>(null);
const popoverRef = ref<HTMLDivElement | null>(null);

function clearSelection() {
  selection.value = null;
  changeInstruction.value = "";
}

function onMouseUp() {
  if (!powerMode.value) return;
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  const text = sel?.toString() ?? "";
  if (!text.trim()) {
    clearSelection();
    return;
  }
  const range = sel!.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const preEl = preRef.value;
  const preRect = preEl?.getBoundingClientRect();
  const offsetTop = preRect ? rect.bottom - preRect.top + 4 : 0;
  selection.value = { text, anchorTop: offsetTop };
}

function sendPowerPrompt() {
  if (!selection.value || !file.value) return;
  const instruction = changeInstruction.value.trim();
  if (!instruction) return;
  const prompt = [
    `In der Datei \`${file.value.path}\`, ändere folgenden Block:`,
    "```",
    selection.value.text,
    "```",
    `Änderung: ${instruction}`
  ].join("\n");
  emit("powerPrompt", prompt);
  clearSelection();
}

const loading = ref(false);
const errorMessage = ref<string | null>(null);
const selectedPath = ref<string | null>(null);
const file = ref<ArtifactFile | null>(null);
const dirEntries = ref<DirectoryEntry[] | null>(null);
const dirBase = ref<string | null>(null);
const selectedDirFile = ref<string | null>(null);

const dirFileEntries = computed(() =>
  (dirEntries.value ?? [])
    .filter((e) => e.isFile)
    .sort((a, b) => a.name.localeCompare(b.name))
);

const isMarkdown = computed(() => !!file.value?.path.toLowerCase().endsWith(".md"));

function surfaceHtmlComments(source: string): string {
  return source.replace(/<!--\s*([\s\S]*?)\s*-->/g, (_match, inner) => {
    const text = String(inner)
      .trim()
      .replace(/[\r\n]+/g, " ")
      .replace(/_/g, "\\_");
    return `\n\n> _${text}_\n\n`;
  });
}

const renderedHtml = computed(() => {
  const source = file.value?.content ?? "";
  if (!source) return "";
  const prepared = surfaceHtmlComments(source);
  const raw = marked.parse(prepared, { async: false, gfm: true, breaks: false }) as string;
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
});

const articleRef = ref<HTMLElement | null>(null);

mermaid.initialize({ startOnLoad: false, theme: "default" });

async function renderMermaidBlocks() {
  if (!articleRef.value) return;
  const blocks = articleRef.value.querySelectorAll("pre code.language-mermaid");
  for (const block of Array.from(blocks)) {
    const code = block.textContent?.trim() ?? "";
    if (!code) continue;
    const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
    try {
      const { svg } = await mermaid.render(id, code);
      // Parse via DOMParser (text/html) so foreignObject HTML content — including <br/> labels
      // — is handled correctly. Avoids innerHTML and the SVG-namespace parsing issues of image/svg+xml.
      const parsed = new DOMParser().parseFromString(svg, "text/html");
      const svgEl = parsed.querySelector("svg");
      if (!svgEl) continue;
      const wrapper = document.createElement("div");
      wrapper.className = "not-prose overflow-x-auto py-4";
      wrapper.appendChild(document.adoptNode(svgEl));
      block.closest("pre")?.replaceWith(wrapper);
    } catch {
      // leave as code block on parse error
    }
  }
}

watch(renderedHtml, async () => {
  await nextTick();
  renderMermaidBlocks();
});

type FsResponse = ArtifactFile | ArtifactDir;

async function fetchPath(p: string): Promise<FsResponse | null> {
  try {
    return (await $fetch<FsResponse>(`/api/projects/${props.slug}/fs`, {
      params: { path: p }
    }));
  } catch (err) {
    const status = (err as { statusCode?: number })?.statusCode;
    if (status === 404) return null;
    throw err;
  }
}

async function selectDirFile(name: string): Promise<void> {
  if (!dirBase.value) return;
  const res = await fetchPath(`${dirBase.value}/${name}`);
  if (res?.type === "file") {
    file.value = res;
    selectedPath.value = `${dirBase.value}/${name}`;
    selectedDirFile.value = name;
  }
}

async function resolveCandidate(): Promise<void> {
  loading.value = true;
  errorMessage.value = null;
  file.value = null;
  dirEntries.value = null;
  dirBase.value = null;
  selectedPath.value = null;
  selectedDirFile.value = null;

  try {
    for (const candidate of props.candidates) {
      if (candidate.includes("<feature>")) {
        const base = candidate.split("/<feature>/")[0];
        const tail = candidate.split("/<feature>/")[1];
        if (!base || !tail) continue;
        const baseRes = await fetchPath(base);
        if (!baseRes) continue;
        if (baseRes.type === "dir") {
          const featureDirs = baseRes.entries.filter((e) => e.isDirectory);
          if (featureDirs.length === 0) {
            dirEntries.value = baseRes.entries;
            dirBase.value = base;
            continue;
          }
          const sorted = [...featureDirs].sort((a, b) => b.name.localeCompare(a.name));
          for (const feat of sorted) {
            const full = `${base}/${feat.name}/${tail}`;
            const res = await fetchPath(full);
            if (res?.type === "file") {
              file.value = res;
              selectedPath.value = full;
              emit("artifactResolved");
              return;
            }
          }
          dirEntries.value = baseRes.entries;
          dirBase.value = base;
        }
      } else {
        const res = await fetchPath(candidate);
        if (!res) continue;
        if (res.type === "file") {
          file.value = res;
          selectedPath.value = candidate;
          emit("artifactResolved");
          return;
        }
        if (res.type === "dir") {
          dirEntries.value = res.entries;
          dirBase.value = candidate;
        }
      }
    }
    // No direct file found — if a directory was resolved, auto-select its first file.
    if (dirBase.value && dirFileEntries.value.length > 0) {
      await selectDirFile(dirFileEntries.value[0]!.name);
      if (file.value) emit("artifactResolved");
    }
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : t("artifact.loadError");
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.slug, props.candidates.join("|"), props.reloadToken],
  () => resolveCandidate(),
  { immediate: true }
);

let watcherSource: EventSource | null = null;
let watcherDebounce: ReturnType<typeof setTimeout> | null = null;

function openWatcher(forSlug: string) {
  closeWatcher();
  if (typeof window === "undefined") return;
  try {
    watcherSource = new EventSource(`/api/projects/${forSlug}/watch`);
    watcherSource.addEventListener("change", () => {
      if (watcherDebounce) clearTimeout(watcherDebounce);
      watcherDebounce = setTimeout(() => {
        resolveCandidate();
      }, 300);
    });
    watcherSource.addEventListener("error", () => {});
  } catch {
    /* SSE unsupported */
  }
}

function closeWatcher() {
  watcherSource?.close();
  watcherSource = null;
  if (watcherDebounce) {
    clearTimeout(watcherDebounce);
    watcherDebounce = null;
  }
}

watch(
  () => props.slug,
  (nextSlug) => {
    if (nextSlug) openWatcher(nextSlug);
  },
  { immediate: true }
);

onUnmounted(() => closeWatcher());
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
      <div class="min-w-0 flex-1">
        <p class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{{ $t("artifact.title") }}</p>
        <p class="mt-0.5 truncate font-mono text-xs">
          {{ selectedPath ?? candidates[0] ?? "–" }}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <button
          type="button"
          class="inline-flex size-7 items-center justify-center rounded-md transition"
          :class="powerMode ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'"
          :title="powerMode ? $t('artifact.powerModeActive') : $t('artifact.powerModeTitle')"
          @click="powerMode = !powerMode; clearSelection()"
        >
          <Wand2 class="size-3.5" />
        </button>
        <button
          type="button"
          class="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
          :title="$t('artifact.reload')"
          :disabled="loading"
          @click="resolveCandidate"
        >
          <RefreshCw class="size-3.5" :class="loading && 'animate-spin'" />
        </button>
        <button
          type="button"
          class="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
          :title="$t('artifact.hide')"
          @click="emit('collapse')"
        >
          <PanelRightClose class="size-3.5" />
        </button>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto">
      <div v-if="loading" class="flex items-center gap-2 p-4 text-xs text-muted-foreground">
        <Loader2 class="size-3.5 animate-spin" />
        <span>{{ $t("common.loading") }}</span>
      </div>

      <div v-else-if="errorMessage" class="m-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
        <div class="flex items-start gap-2">
          <FileWarning class="mt-0.5 size-3.5 shrink-0" />
          <span>{{ errorMessage }}</span>
        </div>
      </div>

      <div v-else-if="file" class="relative">
        <!-- File picker when resolved from a directory with multiple files -->
        <div
          v-if="dirBase && dirFileEntries.length > 1"
          class="sticky top-0 z-10 border-b border-border/60 bg-background px-3 py-2"
        >
          <Select :model-value="selectedDirFile ?? undefined" @update:model-value="selectDirFile">
            <SelectTrigger class="h-7 font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="f in dirFileEntries" :key="f.name" :value="f.name" class="font-mono text-xs">
                {{ f.name }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div
          v-if="powerMode"
          class="sticky top-0 z-10 border-b border-primary/30 bg-primary/5 px-4 py-2 text-[11px] text-primary"
        >
          <Wand2 class="mr-1 inline size-3" />
          {{ $t("artifact.powerModeHint") }}
        </div>
        <article
          v-if="isMarkdown && !powerMode"
          ref="articleRef"
          class="prose prose-sm relative max-w-none p-4 prose-headings:text-foreground prose-a:text-primary prose-code:text-foreground prose-pre:bg-muted prose-pre:text-foreground"
          v-html="renderedHtml"
        />
        <pre
          v-else
          ref="preRef"
          class="relative whitespace-pre-wrap wrap-break-word p-4 font-mono text-[12px] leading-6"
          :class="powerMode && 'cursor-text selection:bg-primary/30'"
          @mouseup="onMouseUp"
        >{{ file.content }}</pre>

        <div
          v-if="selection"
          ref="popoverRef"
          class="absolute left-4 right-4 z-20 rounded-md border border-border bg-popover p-3 shadow-lg"
          :style="{ top: selection.anchorTop + 'px' }"
        >
          <div class="flex items-start justify-between gap-2">
            <p class="text-[11px] font-medium">{{ $t("artifact.changeTitle") }}</p>
            <button
              type="button"
              class="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              @click="clearSelection"
            >
              <X class="size-3" />
            </button>
          </div>
          <div class="mt-1.5 rounded border border-border/60 bg-muted/40 p-1.5 text-[10px]">
            <p class="line-clamp-3 font-mono">{{ selection.text }}</p>
          </div>
          <textarea
            v-model="changeInstruction"
            rows="2"
            class="mt-2 w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
            :placeholder="$t('artifact.changeInstructionPlaceholder')"
            @keydown.meta.enter.prevent="sendPowerPrompt"
            @keydown.ctrl.enter.prevent="sendPowerPrompt"
          />
          <div class="mt-2 flex justify-end">
            <Button size="sm" :disabled="!changeInstruction.trim()" @click="sendPowerPrompt">
              {{ $t("artifact.sendAsPrompt") }}
            </Button>
          </div>
        </div>

        <div class="border-t border-border/60 px-4 py-2 text-[10px] text-muted-foreground">
          {{ file.size }} B · geändert {{ new Date(file.mtime).toLocaleString() }}
        </div>
      </div>

      <!-- Only shown when directory exists but contains no files (files auto-select into the file view above) -->
      <div v-else-if="dirBase" class="p-4 text-xs text-muted-foreground">
        <p class="mb-1 font-mono font-medium text-foreground">{{ dirBase }}/</p>
        <p class="italic">{{ $t("artifact.dirEmpty") }}</p>
      </div>

      <div v-else class="p-4 text-xs text-muted-foreground">
        <p>{{ $t("artifact.notExists") }}</p>
        <p class="mt-1 italic opacity-70">{{ $t("artifact.notExistsHint") }}</p>
      </div>
    </div>
  </div>
</template>
