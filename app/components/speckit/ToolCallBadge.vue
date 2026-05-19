<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronRight, Wrench } from "lucide-vue-next";

const props = defineProps<{
  toolName: string;
  input?: unknown;
  output?: unknown;
  state?: "calling" | "result" | "error";
}>();

const open = ref(false);

const stateLabel = computed(() => {
  if (props.state === "error") return "error";
  if (props.state === "result") return "done";
  return "running";
});

const inputPreview = computed(() => safeStringify(props.input));
const outputPreview = computed(() => safeStringify(props.output));

function safeStringify(v: unknown): string {
  if (v === undefined) return "—";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
</script>

<template>
  <div class="rounded-md border border-border bg-muted/30 text-sm">
    <button
      type="button"
      class="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-muted/50"
      @click="open = !open"
    >
      <Wrench class="size-3.5 shrink-0 text-muted-foreground" />
      <span class="font-mono text-xs">{{ toolName }}</span>
      <span
        class="ml-auto rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
        :class="{
          'bg-emerald-500/10 text-emerald-600': state === 'result',
          'bg-amber-500/10 text-amber-600': !state || state === 'calling',
          'bg-destructive/10 text-destructive': state === 'error',
        }"
      >
        {{ stateLabel }}
      </span>
      <ChevronRight
        class="size-3.5 shrink-0 text-muted-foreground transition"
        :class="{ 'rotate-90': open }"
      />
    </button>
    <div v-if="open" class="space-y-2 border-t border-border bg-background/60 p-3">
      <div>
        <p class="text-[11px] font-medium uppercase text-muted-foreground">Input</p>
        <pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">{{ inputPreview }}</pre>
      </div>
      <div v-if="output !== undefined">
        <p class="text-[11px] font-medium uppercase text-muted-foreground">Output</p>
        <pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">{{ outputPreview }}</pre>
      </div>
    </div>
  </div>
</template>
