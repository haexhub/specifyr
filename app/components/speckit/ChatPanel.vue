<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Loader2, Send, Square, UploadCloud } from "lucide-vue-next";
import { Button } from "~/components/shadcn/button";
import ToolCallBadge from "~/components/speckit/ToolCallBadge.vue";
import type { ActiveSession, SaveState } from "~/stores/active-session";

const props = defineProps<{
  session: ActiveSession | null;
  isStreaming: boolean;
  saveState: SaveState;
  pendingSave: boolean;
}>();

const emit = defineEmits<{
  send: [text: string];
  cancel: [];
  publish: [];
  retrySave: [];
}>();

const composer = ref("");
const scrollRef = ref<HTMLElement | null>(null);

type RenderedTextPart = { kind: "text"; text: string };
type RenderedToolCallPart = {
  kind: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  state: "calling" | "result" | "error";
};
type RenderedReasoningPart = { kind: "reasoning"; text: string };
type RenderedPart = RenderedTextPart | RenderedToolCallPart | RenderedReasoningPart;

type RenderedMessage = {
  role: "user" | "assistant";
  parts: RenderedPart[];
};

const messages = computed<RenderedMessage[]>(() => {
  if (!props.session) return [];

  // Index tool results by toolCallId so we can collapse them into the
  // matching tool-call part on the preceding assistant message. This
  // keeps the UI linear (one badge per call) instead of showing the
  // result as a separate, orphan-looking message.
  const toolResults = new Map<string, { output: unknown; state: "result" | "error" }>();
  for (const m of props.session.conversation) {
    const role = (m as { role?: unknown }).role;
    if (role !== "tool") continue;
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const id = (part as { toolCallId?: unknown }).toolCallId;
      const output = (part as { output?: unknown }).output;
      const isError = (part as { isError?: unknown }).isError === true;
      if (typeof id === "string") {
        toolResults.set(id, { output, state: isError ? "error" : "result" });
      }
    }
  }

  const out: RenderedMessage[] = [];
  for (const m of props.session.conversation) {
    const role = (m as { role?: unknown }).role;
    if (role === "tool" || role === "system") continue;
    if (role !== "user" && role !== "assistant") continue;
    out.push({ role, parts: renderParts(m, toolResults) });
  }
  return out;
});

function renderParts(
  message: unknown,
  toolResults: Map<string, { output: unknown; state: "result" | "error" }>,
): RenderedPart[] {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return [{ kind: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];

  const parts: RenderedPart[] = [];
  for (const raw of content) {
    const type = (raw as { type?: unknown }).type;
    if (type === "text") {
      const text = (raw as { text?: unknown }).text;
      if (typeof text === "string") parts.push({ kind: "text", text });
    } else if (type === "tool-call") {
      const id = (raw as { toolCallId?: unknown }).toolCallId;
      const name = (raw as { toolName?: unknown }).toolName;
      const input = (raw as { input?: unknown }).input;
      if (typeof id === "string" && typeof name === "string") {
        const paired = toolResults.get(id);
        parts.push({
          kind: "tool-call",
          toolCallId: id,
          toolName: name,
          input,
          output: paired?.output,
          state: paired?.state ?? "calling",
        });
      }
    } else if (type === "reasoning") {
      const text = (raw as { text?: unknown }).text;
      if (typeof text === "string") parts.push({ kind: "reasoning", text });
    }
  }
  return parts;
}

const saveLabel = computed(() => {
  switch (props.saveState.kind) {
    case "idle":
      return props.pendingSave ? "Unsaved" : "Saved";
    case "saving":
      return `Saving (${props.saveState.attempt}/${4})…`;
    case "retrying":
      return `Retrying (${props.saveState.attempt}/3)…`;
    case "failed":
      return "Save failed";
  }
});

const saveToneClass = computed(() => {
  switch (props.saveState.kind) {
    case "failed":
      return "text-destructive";
    case "saving":
    case "retrying":
      return "text-amber-600";
    case "idle":
      return props.pendingSave ? "text-muted-foreground" : "text-emerald-600";
  }
});

const canPublish = computed(
  () =>
    !!props.session &&
    props.session.status === "draft" &&
    !props.isStreaming &&
    props.saveState.kind === "idle" &&
    !props.pendingSave,
);

const canSend = computed(
  () =>
    !!props.session &&
    !props.isStreaming &&
    composer.value.trim().length > 0,
);

function send() {
  const text = composer.value.trim();
  if (!text || !canSend.value) return;
  composer.value = "";
  emit("send", text);
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

// Auto-scroll to bottom when conversation grows.
watch(
  () => props.session?.conversation.length,
  async () => {
    await nextTick();
    if (scrollRef.value) {
      scrollRef.value.scrollTop = scrollRef.value.scrollHeight;
    }
  },
);
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
      <div class="min-w-0">
        <p class="truncate text-sm font-semibold">
          {{ session?.title ?? "No draft selected" }}
        </p>
        <p v-if="session" class="text-xs text-muted-foreground">
          base v{{ session.baseVersion }} · {{ session.status }}
        </p>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-xs" :class="saveToneClass">{{ saveLabel }}</span>
        <Button
          v-if="saveState.kind === 'failed'"
          type="button"
          size="sm"
          variant="outline"
          @click="emit('retrySave')"
        >
          Retry save
        </Button>
        <Button
          type="button"
          size="sm"
          :disabled="!canPublish"
          @click="emit('publish')"
        >
          <UploadCloud class="size-3.5" /> Publish
        </Button>
      </div>
    </header>

    <div ref="scrollRef" class="flex-1 space-y-4 overflow-y-auto px-4 py-4">
      <div
        v-if="!session"
        class="flex h-full items-center justify-center text-sm text-muted-foreground"
      >
        Pick a draft from the sidebar or create a new one to start.
      </div>

      <div
        v-for="(msg, i) in messages"
        :key="i"
        class="flex flex-col gap-2"
        :class="{ 'items-end': msg.role === 'user' }"
      >
        <div
          class="max-w-[85%] space-y-2 rounded-lg px-3 py-2 text-sm"
          :class="{
            'bg-primary/10': msg.role === 'user',
            'bg-muted/40': msg.role === 'assistant',
          }"
        >
          <template v-for="(part, pi) in msg.parts" :key="pi">
            <p v-if="part.kind === 'text'" class="whitespace-pre-wrap leading-relaxed">{{ part.text }}</p>
            <details v-else-if="part.kind === 'reasoning'" class="text-xs text-muted-foreground">
              <summary class="cursor-pointer select-none">reasoning</summary>
              <p class="mt-1 whitespace-pre-wrap leading-relaxed">{{ part.text }}</p>
            </details>
            <ToolCallBadge
              v-else
              :tool-name="part.toolName"
              :input="part.input"
              :output="part.output"
              :state="part.state"
            />
          </template>
        </div>
      </div>

      <div v-if="isStreaming" class="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 class="size-3.5 animate-spin" /> streaming…
      </div>
    </div>

    <footer class="border-t border-border px-4 py-3">
      <div class="flex items-end gap-2">
        <textarea
          v-model="composer"
          rows="3"
          placeholder="Describe the change you want to make to the spec…"
          class="min-h-[3rem] flex-1 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none ring-offset-background transition focus:ring-2 focus:ring-ring focus:ring-offset-2"
          :disabled="!session || isStreaming"
          @keydown="onKeyDown"
        />
        <Button
          v-if="isStreaming"
          type="button"
          variant="outline"
          @click="emit('cancel')"
        >
          <Square class="size-3.5" /> Stop
        </Button>
        <Button
          v-else
          type="button"
          :disabled="!canSend"
          @click="send"
        >
          <Send class="size-3.5" /> Send
        </Button>
      </div>
      <p class="mt-1 text-[11px] text-muted-foreground">Enter to send · Shift+Enter for newline</p>
    </footer>
  </div>
</template>
