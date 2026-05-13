<script setup lang="ts">
import { MessageSquarePlus, Loader2, CheckCircle2, AlertCircle, Trash2 } from "lucide-vue-next";
import type { SessionMetadata } from "~/types/types";

const props = defineProps<{
  slug: string;
  stepId: string;
  activeSessionId: string | null;
  sessions: SessionMetadata[];
  loading?: boolean;
  creating?: boolean;
}>();

const emit = defineEmits<{
  select: [sessionId: string];
  create: [];
  delete: [session: SessionMetadata, event: MouseEvent];
}>();

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "eben";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
</script>

<template>
  <div class="flex flex-col">
    <div class="flex items-center justify-between px-3 pb-2 pt-3">
      <p class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{{ $t("sessions.label") }}</p>
      <button
        type="button"
        class="inline-flex size-6 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="creating"
        :title="$t('sessions.newTitle')"
        @click="emit('create')"
      >
        <Loader2 v-if="creating" class="size-3.5 animate-spin" />
        <MessageSquarePlus v-else class="size-3.5" />
      </button>
    </div>

    <ul class="flex flex-col gap-0.5 px-2">
      <li v-for="session in sessions" :key="session.id" class="group relative">
        <button
          type="button"
          class="flex w-full items-start gap-2 rounded-md px-2 py-1.5 pr-8 text-left text-xs transition"
          :class="session.id === activeSessionId
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'"
          @click="emit('select', session.id)"
        >
          <span class="mt-0.5 shrink-0">
            <Loader2 v-if="session.status === 'running'" class="size-3 animate-spin text-primary" />
            <CheckCircle2 v-else-if="session.status === 'completed'" class="size-3 text-emerald-600" />
            <AlertCircle v-else-if="session.status === 'failed'" class="size-3 text-destructive" />
            <span v-else class="block size-1.5 rounded-full bg-muted-foreground/40" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate">{{ session.title }}</span>
            <span class="block text-[10px] opacity-60">
              {{ session.messageCount }} msg · {{ relative(session.updatedAt) }}
            </span>
          </span>
        </button>
        <button
          type="button"
          class="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-destructive/10 hover:text-destructive"
          :title="$t('sessions.delete')"
          :aria-label="$t('sessions.delete')"
          @click.stop="emit('delete', session, $event)"
        >
          <Trash2 class="size-3" />
        </button>
      </li>
    </ul>

    <p v-if="!sessions.length && !loading" class="px-3 py-3 text-xs text-muted-foreground">
      {{ $t("sessions.noSessions") }}
    </p>
    <p v-if="loading" class="px-3 py-3 text-xs text-muted-foreground">{{ $t("common.loading") }}</p>
  </div>
</template>
