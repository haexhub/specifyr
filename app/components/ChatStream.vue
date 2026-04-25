<script setup lang="ts">
import { Send, Loader2, MessageSquarePlus, Info, ArrowRight, FileText, RotateCcw } from "lucide-vue-next";
import { Button } from "~/components/ui/button";
import ChatMessage from "~/components/ChatMessage.vue";
import type { ChatMessage as ChatMessageType, SessionMetadata } from "~/lib/types";

const props = defineProps<{
  slug: string;
  stepId: string;
  session: SessionMetadata | null;
  // Short, human-written description of the step (one sentence from extension.yml or the
  // built-in workflow). The command markdown body is intentionally NOT used here — it's
  // written for the LLM, not the user.
  stepDescription?: string;
  // The primary artifact this step produces, if known.
  stepOutput?: string;
  // Label of the next step in the workflow.
  nextStepLabel?: string;
}>();

const emit = defineEmits<{
  turnCompleted: [];
}>();

const messages = ref<ChatMessageType[]>([]);
const messagesLoading = ref(false);
const draft = ref("");
const streaming = ref(false);
const streamError = ref<string | null>(null);
const chatContainer = ref<HTMLDivElement | null>(null);

// Locally extended session view: GET /sessions/<sid> returns the meta + messages and now
// also lastEventSeq + runningSinceSeq. We refetch on session change and after turns end.
type SessionDetail = SessionMetadata & {
  messages: ChatMessageType[];
  lastEventSeq?: number;
  runningSinceSeq?: number | null;
};
const sessionView = ref<SessionDetail | null>(null);

// Live streaming state — rebuilt from disk replay on reconnect, so no localStorage needed.
const streamingMessage = ref<ChatMessageType | null>(null);
const currentToolUses = ref<{ name: string; input: unknown }[]>([]);
// Claude often emits text → tool_use → text. Without a separator the post-tool text reads
// as one garbled paragraph. We track whether a tool_use happened since the last text block
// so the next text gets a clean break.
const toolUseSinceLastText = ref(false);
const lastSeenSeq = ref(0);

// Active EventSource. We keep a handle so we can close it when switching sessions or
// unmounting. Browser auto-reconnects on network drops via Last-Event-ID; we don't need
// to reconnect manually.
let eventSource: EventSource | null = null;

async function loadSession(sid: string) {
  messagesLoading.value = true;
  streamError.value = null;
  try {
    const data = await $fetch<SessionDetail>(
      `/api/projects/${props.slug}/steps/${props.stepId}/sessions/${sid}`
    );
    sessionView.value = data;
    messages.value = data.messages ?? [];
  } catch (err) {
    streamError.value = err instanceof Error ? err.message : "Session konnte nicht geladen werden.";
    messages.value = [];
    sessionView.value = null;
  } finally {
    messagesLoading.value = false;
    scrollToBottom();
  }
}

function closeStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  streaming.value = false;
}

function resetStreamingDisplay() {
  streamingMessage.value = null;
  currentToolUses.value = [];
  toolUseSinceLastText.value = false;
}

watch(
  () => props.session?.id,
  async (nextId) => {
    closeStream();
    draft.value = "";
    resetStreamingDisplay();
    if (!nextId) {
      messages.value = [];
      sessionView.value = null;
      return;
    }
    await loadSession(nextId);
    // Auto-subscribe if a turn is in flight: catch up on what was streamed while the
    // page was closed/refreshed and continue receiving live tokens.
    if (sessionView.value?.status === "running") {
      const since = sessionView.value.runningSinceSeq ?? sessionView.value.lastEventSeq ?? 0;
      openStream(nextId, since);
    }
  },
  { immediate: true }
);

function scrollToBottom() {
  nextTick(() => {
    const el = chatContainer.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function appendTextToStreamingMessage(text: string) {
  if (!streamingMessage.value) {
    streamingMessage.value = {
      id: `streaming-${Date.now()}`,
      role: "assistant",
      content: text,
      createdAt: new Date().toISOString()
    };
  } else {
    streamingMessage.value = {
      ...streamingMessage.value,
      content: streamingMessage.value.content + text
    };
  }
}

function handleClaudeEvent(payload: any) {
  if (payload?.type === "assistant" && Array.isArray(payload.message?.content)) {
    for (const block of payload.message.content) {
      if (block?.type === "text" && typeof block.text === "string") {
        const text = block.text;
        if (toolUseSinceLastText.value && streamingMessage.value?.content) {
          appendTextToStreamingMessage(`\n\n${text}`);
        } else {
          appendTextToStreamingMessage(text);
        }
        toolUseSinceLastText.value = false;
      } else if (block?.type === "tool_use" && block.name) {
        currentToolUses.value = [...currentToolUses.value, { name: block.name, input: block.input }];
        toolUseSinceLastText.value = true;
      }
    }
    scrollToBottom();
  }
  // Other types (system init, user tool_result, result) ignored — server persists the
  // final assistant message and we pick it up via the assistant_message event.
}

/**
 * Open (or reopen) the EventSource for this session's turn stream.
 *
 * Replays disk events with seq > since, then live-tails until the turn ends. The browser
 * auto-reconnects with Last-Event-ID on transient network drops, so we only manage the
 * lifecycle on session changes / unmount.
 */
function openStream(sid: string, since: number) {
  closeStream();
  resetStreamingDisplay();
  lastSeenSeq.value = since;
  streaming.value = true;
  streamError.value = null;

  const url = `/api/projects/${props.slug}/steps/${props.stepId}/sessions/${sid}/turn/stream?since=${since}`;
  const es = new EventSource(url);
  eventSource = es;

  const updateSeq = (raw: string) => {
    try {
      const wrapped = JSON.parse(raw) as { seq?: number; data?: unknown };
      if (typeof wrapped.seq === "number" && wrapped.seq > lastSeenSeq.value) {
        lastSeenSeq.value = wrapped.seq;
      }
      return wrapped.data;
    } catch {
      return undefined;
    }
  };

  es.addEventListener("claude", (ev: MessageEvent) => {
    const data = updateSeq(ev.data);
    if (data) handleClaudeEvent(data);
  });

  es.addEventListener("assistant_message", (ev: MessageEvent) => {
    const data = updateSeq(ev.data) as ChatMessageType | undefined;
    if (!data) return;
    // Dedupe: catchup may replay an already-persisted message we'd otherwise show twice.
    if (!messages.value.some((m) => m.id === data.id)) {
      messages.value = [...messages.value, data];
    }
    streamingMessage.value = null;
  });

  es.addEventListener("done", (ev: MessageEvent) => {
    updateSeq(ev.data);
    closeStream();
    emit("turnCompleted");
    // Refresh meta so the UI reflects status=completed and clears runningSinceSeq.
    void loadSession(sid);
    scrollToBottom();
  });

  // Server-side application failures use a NAMED event ("turn_failed") because the DOM
  // EventSource API treats the literal "error" event type as a connection error and
  // doesn't deliver our payload reliably.
  es.addEventListener("turn_failed", (ev: MessageEvent) => {
    const data = updateSeq(ev.data) as { message?: string } | undefined;
    streamError.value = data?.message ?? "Turn fehlgeschlagen.";
    closeStream();
    void loadSession(sid);
  });

  // The standard "error" handler fires for connection drops. The browser auto-reconnects
  // with Last-Event-ID — we just log silently. If the reconnect ultimately fails (max
  // retries exceeded), readyState becomes CLOSED and we surface a hint.
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      // Connection truly dead — server probably restarted or session ended.
      eventSource = null;
      streaming.value = false;
    }
    // Otherwise: transient drop, browser reconnecting. Stay quiet.
  };
}

async function send() {
  const content = draft.value.trim();
  if (!content || streaming.value) return;
  if (!props.session) return;

  const sid = props.session.id;

  // Optimistic user message — replaced when GET reload syncs server state, but we don't
  // need to wait for that to show it.
  const optimistic: ChatMessageType = {
    id: `pending-${Date.now()}`,
    role: "user",
    content,
    createdAt: new Date().toISOString()
  };
  messages.value = [...messages.value, optimistic];
  draft.value = "";
  streamError.value = null;
  scrollToBottom();

  try {
    const resp = await $fetch<{ accepted: boolean; startSeq: number; userMessage: ChatMessageType }>(
      `/api/projects/${props.slug}/steps/${props.stepId}/sessions/${sid}/turn`,
      { method: "POST", body: { content } }
    );
    // Replace optimistic message with server-persisted one (carries the real id).
    messages.value = messages.value.map((m) => (m.id === optimistic.id ? resp.userMessage : m));
    openStream(sid, resp.startSeq);
  } catch (err: any) {
    // Roll back the optimistic message on POST failure.
    messages.value = messages.value.filter((m) => m.id !== optimistic.id);
    streamError.value =
      err?.statusCode === 409
        ? "Für diese Session läuft bereits ein Turn."
        : err instanceof Error
        ? err.message
        : "Turn konnte nicht gestartet werden.";
  }
}

async function retryInterruptedTurn() {
  if (!props.session) return;
  const sid = props.session.id;
  // Take the last user message from the persisted history and re-send it. The server's
  // first-turn-prepend logic fires only when messageCount === 0, so a retry sends the
  // user content straight to Claude — Claude resumes via the stored claudeSessionId.
  const lastUser = [...messages.value].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    streamError.value = "Keine User-Nachricht zum Wiederholen gefunden.";
    return;
  }
  draft.value = lastUser.content;
  // Strip the optimistic last user message so send() can re-add cleanly. Actually, since
  // the user message is already persisted, we shouldn't re-append it. Send a quieter
  // re-trigger: POST without optimistic, then open stream.
  try {
    streamError.value = null;
    const resp = await $fetch<{ accepted: boolean; startSeq: number }>(
      `/api/projects/${props.slug}/steps/${props.stepId}/sessions/${sid}/turn`,
      { method: "POST", body: { content: lastUser.content } }
    );
    draft.value = "";
    openStream(sid, resp.startSeq);
  } catch (err: any) {
    streamError.value = err instanceof Error ? err.message : "Retry fehlgeschlagen.";
  }
}

function handleKeydown(ev: KeyboardEvent) {
  if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    send();
  }
}

function insertIntoDraft(text: string) {
  const current = draft.value.trim();
  draft.value = current ? `${current}\n\n${text}` : text;
}

defineExpose({ insertIntoDraft });

onUnmounted(() => closeStream());

const isInterrupted = computed(() => sessionView.value?.status === "interrupted");
</script>

<template>
  <div class="flex h-full flex-col">
    <div
      v-if="!session"
      class="flex flex-1 items-center justify-center p-8"
    >
      <div class="max-w-md text-center">
        <div class="mx-auto mb-4 inline-flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <MessageSquarePlus class="size-6" />
        </div>
        <p class="text-sm text-muted-foreground">
          Keine Session ausgewählt. Klicke links auf "+ Neue Session" oder wähle eine bestehende.
        </p>
      </div>
    </div>

    <template v-else>
      <div ref="chatContainer" class="flex-1 space-y-4 overflow-y-auto p-6">
        <p v-if="messagesLoading" class="text-center text-xs text-muted-foreground">Lade Session…</p>

        <div
          v-if="!messagesLoading && !messages.length && !streamingMessage && stepDescription"
          class="rounded-lg border border-primary/20 bg-primary/5 p-4"
        >
          <div class="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-primary">
            <Info class="size-3.5" />
            Was dieser Step macht
          </div>
          <p class="text-sm leading-6 text-foreground">{{ stepDescription }}</p>
          <dl class="mt-3 space-y-1 text-xs">
            <div v-if="stepOutput" class="flex items-center gap-1.5">
              <FileText class="size-3.5 text-muted-foreground" />
              <dt class="text-muted-foreground">Ausgabe:</dt>
              <dd><code class="rounded bg-muted px-1 py-0.5 font-mono">{{ stepOutput }}</code></dd>
            </div>
            <div v-if="nextStepLabel" class="flex items-center gap-1.5">
              <ArrowRight class="size-3.5 text-muted-foreground" />
              <dt class="text-muted-foreground">Nächster Schritt:</dt>
              <dd class="font-medium">{{ nextStepLabel }}</dd>
            </div>
          </dl>
          <p class="mt-3 text-[11px] italic text-muted-foreground">
            Tippe unten deinen ersten Prompt — der Step-Command wird automatisch angehängt.
          </p>
        </div>

        <p
          v-else-if="!messagesLoading && !messages.length && !streamingMessage"
          class="text-center text-xs text-muted-foreground"
        >
          Neue Session. Tippe unten deinen ersten Prompt.
        </p>

        <ChatMessage
          v-for="m in messages"
          :key="m.id"
          :message="m"
        />
        <ChatMessage
          v-if="streamingMessage"
          :message="streamingMessage"
          streaming
        />

        <div
          v-if="isInterrupted"
          class="flex items-start gap-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2.5 text-xs"
        >
          <RotateCcw class="mt-0.5 size-3.5 shrink-0 text-warning" />
          <div class="flex-1 text-foreground">
            <p class="font-medium">Turn wurde durch Server-Neustart unterbrochen.</p>
            <p class="mt-0.5 text-muted-foreground">
              Claude lief noch, als der Server starb. Die bisher gestreamten Tokens sind oben sichtbar.
              Erneut starten setzt Claudes Conversation fort.
            </p>
          </div>
          <Button size="sm" variant="outline" @click="retryInterruptedTurn">Erneut starten</Button>
        </div>

        <p v-if="streamError" class="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          Fehler: {{ streamError }}
        </p>
      </div>

      <div class="border-t border-border bg-muted/10 p-4">
        <div class="rounded-md border border-input bg-background">
          <textarea
            v-model="draft"
            rows="3"
            class="w-full resize-none rounded-md bg-transparent px-3 py-2.5 text-sm outline-none"
            placeholder="Nachricht tippen… (Cmd/Ctrl+Enter zum Senden)"
            :disabled="streaming"
            @keydown="handleKeydown"
          />
          <div class="flex items-center justify-between border-t border-border/70 px-3 py-2">
            <p class="text-[11px] text-muted-foreground">
              <code class="rounded bg-muted px-1 py-0.5">Cmd/Ctrl + Enter</code> senden
            </p>
            <Button
              size="sm"
              :disabled="!draft.trim() || streaming"
              @click="send"
            >
              <Loader2 v-if="streaming" class="mr-1.5 size-3.5 animate-spin" />
              <Send v-else class="mr-1.5 size-3.5" />
              {{ streaming ? "Läuft…" : "Senden" }}
            </Button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
