<script setup lang="ts">
import { Send, Loader2, MessageSquarePlus, Info, ArrowRight, FileText, RotateCcw, Square } from "lucide-vue-next";
import { Button } from "~/components/ui/button";
import ChatMessage from "~/components/ChatMessage.vue";
import type { ChatMessage as ChatMessageType, SessionMetadata } from "~/lib/types";

const props = defineProps<{
  slug: string;
  stepId: string;
  session: SessionMetadata | null;
  stepDescription?: string;
  stepOutput?: string;
  nextStepLabel?: string;
}>();

const emit = defineEmits<{
  turnCompleted: [];
}>();

const { t } = useI18n();

const messages = ref<ChatMessageType[]>([]);
const messagesLoading = ref(false);
const draft = ref("");
const streaming = ref(false);
const waitingForFirstToken = ref(false);
const streamError = ref<string | null>(null);
const chatContainer = ref<HTMLDivElement | null>(null);

type SessionDetail = SessionMetadata & {
  messages: ChatMessageType[];
  lastEventSeq?: number;
  runningSinceSeq?: number | null;
};
const sessionView = ref<SessionDetail | null>(null);

const streamingMessage = ref<ChatMessageType | null>(null);
const currentToolUses = ref<{ name: string; input: unknown }[]>([]);
const toolUseSinceLastText = ref(false);
const lastSeenSeq = ref(0);

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
    streamError.value = err instanceof Error ? err.message : t("chat.sessionLoadError");
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
  waitingForFirstToken.value = false;
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
}

function openStream(sid: string, since: number) {
  closeStream();
  resetStreamingDisplay();
  lastSeenSeq.value = since;
  streaming.value = true;
  waitingForFirstToken.value = true;
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
    waitingForFirstToken.value = false;
    const data = updateSeq(ev.data);
    if (data) handleClaudeEvent(data);
  });

  es.addEventListener("assistant_message", (ev: MessageEvent) => {
    const data = updateSeq(ev.data) as ChatMessageType | undefined;
    if (!data) return;
    if (!messages.value.some((m) => m.id === data.id)) {
      messages.value = [...messages.value, data];
    }
    streamingMessage.value = null;
  });

  es.addEventListener("done", (ev: MessageEvent) => {
    updateSeq(ev.data);
    closeStream();
    emit("turnCompleted");
    void loadSession(sid);
    scrollToBottom();
  });

  es.addEventListener("turn_failed", (ev: MessageEvent) => {
    const data = updateSeq(ev.data) as { message?: string } | undefined;
    streamError.value = data?.message ?? t("chat.sessionLoadError");
    closeStream();
    void loadSession(sid);
  });

  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      eventSource = null;
      streaming.value = false;
    }
  };
}

async function send() {
  const content = draft.value.trim();
  if (!content || streaming.value) return;
  if (!props.session) return;

  const sid = props.session.id;

  const optimistic: ChatMessageType = {
    id: `pending-${Date.now()}`,
    role: "user",
    content,
    createdAt: new Date().toISOString()
  };
  messages.value = [...messages.value, optimistic];
  draft.value = "";
  streamError.value = null;
  waitingForFirstToken.value = true;
  scrollToBottom();

  try {
    const resp = await $fetch<{ accepted: boolean; startSeq: number; userMessage: ChatMessageType }>(
      `/api/projects/${props.slug}/steps/${props.stepId}/sessions/${sid}/turn`,
      { method: "POST", body: { content } }
    );
    messages.value = messages.value.map((m) => (m.id === optimistic.id ? resp.userMessage : m));
    openStream(sid, resp.startSeq);
  } catch (err: any) {
    waitingForFirstToken.value = false;
    messages.value = messages.value.filter((m) => m.id !== optimistic.id);
    streamError.value =
      err?.statusCode === 409
        ? t("chat.turnError409")
        : err instanceof Error
        ? err.message
        : t("chat.turnStartError");
  }
}

async function retryInterruptedTurn() {
  if (!props.session) return;
  const sid = props.session.id;
  const lastUser = [...messages.value].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    streamError.value = t("chat.retryNoMessage");
    return;
  }
  draft.value = lastUser.content;
  try {
    streamError.value = null;
    const resp = await $fetch<{ accepted: boolean; startSeq: number }>(
      `/api/projects/${props.slug}/steps/${props.stepId}/sessions/${sid}/turn`,
      { method: "POST", body: { content: lastUser.content } }
    );
    draft.value = "";
    openStream(sid, resp.startSeq);
  } catch (err: any) {
    streamError.value = err instanceof Error ? err.message : t("chat.retryError");
  }
}

async function stopTurn() {
  if (!props.session || !streaming.value) return;
  const sid = props.session.id;
  closeStream();
  try {
    await $fetch(
      `/api/projects/${props.slug}/steps/${props.stepId}/sessions/${sid}/turn`,
      { method: "DELETE" }
    );
  } catch {
    // Ignore
  }
  void loadSession(sid);
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
          {{ $t("chat.noSession") }}
        </p>
      </div>
    </div>

    <template v-else>
      <div ref="chatContainer" class="flex-1 space-y-4 overflow-y-auto p-6">
        <p v-if="messagesLoading" class="text-center text-xs text-muted-foreground">{{ $t("chat.loadingSession") }}</p>

        <div
          v-if="!messagesLoading && !messages.length && !streamingMessage && stepDescription"
          class="rounded-lg border border-primary/20 bg-primary/5 p-4"
        >
          <div class="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-primary">
            <Info class="size-3.5" />
            {{ $t("chat.stepInfoTitle") }}
          </div>
          <p class="text-sm leading-6 text-foreground">{{ stepDescription }}</p>
          <dl class="mt-3 space-y-1 text-xs">
            <div v-if="stepOutput" class="flex items-center gap-1.5">
              <FileText class="size-3.5 text-muted-foreground" />
              <dt class="text-muted-foreground">{{ $t("chat.output") }}</dt>
              <dd><code class="rounded bg-muted px-1 py-0.5 font-mono">{{ stepOutput }}</code></dd>
            </div>
            <div v-if="nextStepLabel" class="flex items-center gap-1.5">
              <ArrowRight class="size-3.5 text-muted-foreground" />
              <dt class="text-muted-foreground">{{ $t("chat.nextStep") }}</dt>
              <dd class="font-medium">{{ nextStepLabel }}</dd>
            </div>
          </dl>
          <p class="mt-3 text-[11px] italic text-muted-foreground">
            {{ $t("chat.firstPromptHint") }}
          </p>
        </div>

        <p
          v-else-if="!messagesLoading && !messages.length && !streamingMessage"
          class="text-center text-xs text-muted-foreground"
        >
          {{ $t("chat.newSession") }}
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
          v-if="waitingForFirstToken"
          class="flex items-center gap-2 px-1"
        >
          <div class="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Loader2 class="size-4 animate-spin" />
          </div>
          <div class="flex gap-1">
            <span class="size-2 rounded-full bg-primary/40 animate-bounce" style="animation-delay: 0ms" />
            <span class="size-2 rounded-full bg-primary/40 animate-bounce" style="animation-delay: 150ms" />
            <span class="size-2 rounded-full bg-primary/40 animate-bounce" style="animation-delay: 300ms" />
          </div>
        </div>

        <div
          v-if="isInterrupted"
          class="flex items-start gap-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2.5 text-xs"
        >
          <RotateCcw class="mt-0.5 size-3.5 shrink-0 text-warning" />
          <div class="flex-1 text-foreground">
            <p class="font-medium">{{ $t("chat.interrupted") }}</p>
            <p class="mt-0.5 text-muted-foreground">
              {{ $t("chat.interruptedDesc") }}
            </p>
          </div>
          <Button size="sm" variant="outline" @click="retryInterruptedTurn">{{ $t("chat.restart") }}</Button>
        </div>

        <p v-if="streamError" class="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {{ $t("chat.errorPrefix", { message: streamError }) }}
        </p>
      </div>

      <div class="border-t border-border bg-muted/10 p-4">
        <div class="rounded-md border border-input bg-background">
          <textarea
            v-model="draft"
            rows="3"
            class="w-full resize-none rounded-md bg-transparent px-3 py-2.5 text-sm outline-none"
            :placeholder="$t('chat.placeholder')"
            :disabled="streaming"
            @keydown="handleKeydown"
          />
          <div class="flex items-center justify-between border-t border-border/70 px-3 py-2">
            <p class="text-[11px] text-muted-foreground">
              <code class="rounded bg-muted px-1 py-0.5">Cmd/Ctrl + Enter</code> {{ $t("chat.send") }}
            </p>
            <Button
              v-if="streaming"
              size="sm"
              variant="outline"
              @click="stopTurn"
            >
              <Square class="mr-1.5 size-3.5 fill-current" />
              {{ $t("chat.stop") }}
            </Button>
            <Button
              v-else
              size="sm"
              :disabled="!draft.trim()"
              @click="send"
            >
              <Send class="mr-1.5 size-3.5" />
              {{ $t("chat.send") }}
            </Button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
