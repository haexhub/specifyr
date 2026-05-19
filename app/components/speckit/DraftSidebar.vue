<script setup lang="ts">
import { computed } from "vue";
import { CheckCircle2, FilePlus, FileText } from "lucide-vue-next";
import { Button } from "~/components/shadcn/button";
import { Badge } from "~/components/shadcn/badge";

export type DraftSummary = {
  id: string;
  title: string;
  baseVersion: number;
  status: "draft" | "published";
  updatedAt: string;
  publishedAt: string | null;
};

const props = defineProps<{
  drafts: DraftSummary[];
  activeDraftId: string | null;
  publicVersion: number;
  busy?: boolean;
}>();

const emit = defineEmits<{
  select: [draftId: string];
  newDraft: [];
}>();

const sorted = computed(() =>
  [...props.drafts].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  ),
);

function fmt(d: string): string {
  return new Date(d).toLocaleString();
}

function rebaseHint(draft: DraftSummary): string | null {
  if (draft.status === "published") return null;
  if (draft.baseVersion < props.publicVersion) {
    return `behind public v${props.publicVersion}`;
  }
  return null;
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
      <p class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        My drafts
      </p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        :disabled="busy"
        @click="emit('newDraft')"
      >
        <FilePlus class="size-3.5" />
        New
      </Button>
    </div>

    <div v-if="!drafts.length" class="px-3 py-4 text-xs text-muted-foreground">
      No drafts yet. Click <span class="font-medium">New</span> to start one from the current public state (v{{ publicVersion }}).
    </div>

    <ul v-else class="flex-1 overflow-y-auto p-2">
      <li v-for="d in sorted" :key="d.id">
        <button
          type="button"
          class="group flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm transition hover:bg-accent/50"
          :class="{ 'bg-accent/60': d.id === activeDraftId }"
          @click="emit('select', d.id)"
        >
          <FileText
            v-if="d.status === 'draft'"
            class="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
          />
          <CheckCircle2
            v-else
            class="mt-0.5 size-3.5 shrink-0 text-emerald-600"
          />
          <div class="min-w-0 flex-1">
            <p class="truncate font-medium leading-snug">{{ d.title }}</p>
            <div class="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span>base v{{ d.baseVersion }}</span>
              <span class="opacity-50">·</span>
              <span>{{ fmt(d.updatedAt) }}</span>
            </div>
            <Badge
              v-if="rebaseHint(d)"
              variant="outline"
              class="mt-1 border-amber-500/40 text-amber-600"
            >
              {{ rebaseHint(d) }}
            </Badge>
            <Badge
              v-else-if="d.status === 'published'"
              variant="outline"
              class="mt-1 border-emerald-500/40 text-emerald-600"
            >
              published
            </Badge>
          </div>
        </button>
      </li>
    </ul>
  </div>
</template>
