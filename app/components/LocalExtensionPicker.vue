<script setup lang="ts">
import { Folder, Home, Server, ChevronRight, ArrowUp, Star, Loader2 } from "lucide-vue-next";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "~/components/ui/dialog";
import { Badge } from "~/components/ui/badge";

interface FilesystemEntry {
  name: string;
  type: "dir";
  hasExtensionYml: boolean;
}
interface BrowseResponse {
  path: string;
  parent: string | null;
  entries: FilesystemEntry[];
  hasExtensionYml: boolean;
  bookmarks: { label: string; path: string }[];
}

const open = defineModel<boolean>("open", { default: false });

const emit = defineEmits<{ select: [path: string] }>();

const currentPath = ref<string>("");
const parentPath = ref<string | null>(null);
const entries = ref<FilesystemEntry[]>([]);
const currentHasYml = ref(false);
const bookmarks = ref<{ label: string; path: string }[]>([]);
const loading = ref(false);
const loadError = ref("");

async function loadPath(target?: string) {
  loading.value = true;
  loadError.value = "";
  try {
    const data = await $fetch<BrowseResponse>("/api/filesystem/browse", {
      query: target ? { path: target } : {}
    });
    currentPath.value = data.path;
    parentPath.value = data.parent;
    entries.value = data.entries;
    currentHasYml.value = data.hasExtensionYml;
    bookmarks.value = data.bookmarks;
  } catch (err) {
    const asRecord = err as { data?: { statusMessage?: unknown }; statusMessage?: unknown; message?: unknown };
    loadError.value =
      (typeof asRecord?.data?.statusMessage === "string" && asRecord.data.statusMessage) ||
      (typeof asRecord?.statusMessage === "string" && asRecord.statusMessage) ||
      (typeof asRecord?.message === "string" && asRecord.message) ||
      "Verzeichnis konnte nicht gelesen werden.";
  } finally {
    loading.value = false;
  }
}

// Load on first open. Re-use previous state on subsequent opens so the user
// doesn't have to navigate from scratch every time.
watch(open, async (isOpen) => {
  if (isOpen && !currentPath.value) await loadPath();
});

// Break the current path into clickable segments. POSIX-only; good enough for
// the platforms this dev tool runs on.
const breadcrumbs = computed(() => {
  const parts = currentPath.value.split("/").filter(Boolean);
  const segments: { label: string; path: string }[] = [{ label: "/", path: "/" }];
  let acc = "";
  for (const part of parts) {
    acc += `/${part}`;
    segments.push({ label: part, path: acc });
  }
  return segments;
});

function enter(entry: FilesystemEntry) {
  loadPath(`${currentPath.value.replace(/\/$/, "")}/${entry.name}`);
}
function goUp() {
  if (parentPath.value) loadPath(parentPath.value);
}
function confirm() {
  if (!currentHasYml.value) return;
  emit("select", currentPath.value);
  open.value = false;
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-2xl">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Folder class="size-5" />
          Ordner mit Extension wählen
        </DialogTitle>
        <DialogDescription>
          Navigiere zum Ordner, der die <code class="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">extension.yml</code> enthält.
          Unterordner mit Stern-Marker sind gültige Extensions.
        </DialogDescription>
      </DialogHeader>

      <!-- Quick bookmarks -->
      <div class="flex flex-wrap gap-1.5">
        <Button
          v-for="bm in bookmarks"
          :key="bm.path"
          variant="outline"
          size="sm"
          class="h-auto px-2.5 py-1 text-xs"
          :disabled="loading"
          @click="loadPath(bm.path)"
        >
          <Home v-if="bm.label === 'Home'" class="mr-1 size-3" />
          <Server v-else class="mr-1 size-3" />
          {{ bm.label }}
        </Button>
      </div>

      <!-- Breadcrumb / current path -->
      <div class="flex items-center gap-1 overflow-x-auto rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs">
        <Button variant="ghost" size="sm" class="h-6 px-1.5" :disabled="loading || !parentPath" @click="goUp">
          <ArrowUp class="size-3" />
        </Button>
        <template v-for="(seg, i) in breadcrumbs" :key="seg.path">
          <ChevronRight v-if="i > 0" class="size-3 shrink-0 text-muted-foreground" />
          <button
            type="button"
            class="shrink-0 rounded px-1 py-0.5 font-mono hover:bg-muted focus:outline-none focus:ring-1 focus:ring-ring"
            :class="i === breadcrumbs.length - 1 ? 'font-semibold text-foreground' : 'text-muted-foreground'"
            :disabled="loading"
            @click="loadPath(seg.path)"
          >
            {{ seg.label }}
          </button>
        </template>
      </div>

      <!-- Entries -->
      <div class="relative h-80 overflow-y-auto rounded-md border border-border">
        <div v-if="loading" class="absolute inset-0 flex items-center justify-center bg-background/60">
          <Loader2 class="size-5 animate-spin text-muted-foreground" />
        </div>
        <p v-if="loadError" class="p-4 text-sm text-destructive">{{ loadError }}</p>
        <ul v-else-if="entries.length" class="divide-y divide-border">
          <li v-for="entry in entries" :key="entry.name">
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40 focus:bg-muted/40 focus:outline-none"
              :disabled="loading"
              @click="enter(entry)"
            >
              <Folder class="size-4 shrink-0" :class="entry.hasExtensionYml ? 'text-primary' : 'text-muted-foreground'" />
              <span class="flex-1 truncate font-mono">{{ entry.name }}</span>
              <Badge v-if="entry.hasExtensionYml" variant="secondary" class="gap-1">
                <Star class="size-3" />
                extension
              </Badge>
            </button>
          </li>
        </ul>
        <p v-else-if="!loadError" class="p-4 text-center text-sm text-muted-foreground">
          Keine Unterordner.
        </p>
      </div>

      <!-- Status line for current dir -->
      <p class="text-xs" :class="currentHasYml ? 'text-primary' : 'text-muted-foreground'">
        <template v-if="currentHasYml">
          ✓ Dieser Ordner enthält eine <code class="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">extension.yml</code> — kann registriert werden.
        </template>
        <template v-else>
          Dieser Ordner enthält keine <code class="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">extension.yml</code>.
        </template>
      </p>

      <DialogFooter>
        <Button variant="ghost" @click="open = false">Abbrechen</Button>
        <Button :disabled="!currentHasYml || loading" @click="confirm">
          Diesen Ordner wählen
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
