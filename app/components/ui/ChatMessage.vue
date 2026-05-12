<script setup lang="ts">
import { User, Bot, TriangleAlert, Wrench, Copy, Check, ChevronDown, Brain } from "lucide-vue-next";
import { useClipboard } from "@vueuse/core";
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";
import type { ChatMessage } from "~/types/types";

const props = defineProps<{
  message: ChatMessage;
  streaming?: boolean;
}>();

const { t } = useI18n();

const showThinking = ref(!!props.streaming);

const { copy, copied } = useClipboard({ copiedDuring: 1500 });

const renderedContent = computed(() => {
  if (props.message.role !== "assistant") return null;
  if (!props.message.content) return null;
  const html = marked.parse(props.message.content, { async: false }) as string;
  return DOMPurify.sanitize(html);
});
</script>

<template>
  <div
    class="group flex gap-3"
    :class="message.role === 'user' ? 'justify-end' : 'justify-start'"
  >
    <div
      v-if="message.role !== 'user'"
      class="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full"
      :class="[
        message.role === 'assistant' && 'bg-primary/10 text-primary',
        message.role === 'system' && 'bg-destructive/10 text-destructive',
        message.role === 'tool' && 'bg-muted text-muted-foreground'
      ]"
    >
      <Bot v-if="message.role === 'assistant'" class="size-4" />
      <TriangleAlert v-else-if="message.role === 'system'" class="size-4" />
      <Wrench v-else-if="message.role === 'tool'" class="size-4" />
    </div>

    <div class="flex max-w-[80%] flex-col gap-1.5">
      <!-- Thinking block -->
      <div
        v-if="message.thinking"
        class="rounded-lg border border-border/60 bg-muted/40 text-xs"
      >
        <button
          class="flex w-full items-center gap-1.5 px-3 py-2 text-muted-foreground hover:text-foreground"
          @click="showThinking = !showThinking"
        >
          <Brain class="size-3.5 shrink-0" />
          <span class="flex-1 text-left font-medium">{{ t("chat.thinking") }}</span>
          <ChevronDown
            class="size-3.5 shrink-0 transition-transform duration-200"
            :class="showThinking ? 'rotate-180' : ''"
          />
        </button>
        <div v-if="showThinking" class="border-t border-border/40 px-3 py-2">
          <pre class="whitespace-pre-wrap wrap-break-word font-sans text-muted-foreground">{{ message.thinking }}</pre>
        </div>
      </div>

      <!-- Message bubble -->
      <div
        class="relative rounded-lg px-4 py-2.5 text-sm leading-6"
        :class="[
          message.role === 'user' && 'bg-primary text-primary-foreground',
          message.role === 'assistant' && 'border border-border bg-card',
          message.role === 'system' && 'border border-destructive/30 bg-destructive/5 text-destructive',
          message.role === 'tool' && 'border border-border bg-muted/60 font-mono text-xs'
        ]"
      >
        <button
          class="absolute right-2 top-2 rounded p-1.5 opacity-0 transition-opacity group-hover:opacity-100"
          :class="[
            message.role === 'user'
              ? 'text-primary-foreground/60 hover:bg-white/10 hover:text-primary-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          ]"
          :title="t('chat.copy')"
          @click="copy(message.content)"
        >
          <Check v-if="copied" class="size-4 text-green-500" />
          <Copy v-else class="size-4" />
        </button>

        <!-- eslint-disable-next-line vue/no-v-html -->
        <div v-if="renderedContent" class="chat-prose pr-6" v-html="renderedContent" />
        <pre v-else class="whitespace-pre-wrap wrap-break-word pr-6 font-sans">{{ message.content }}</pre>
        <span
          v-if="streaming"
          class="ml-1 inline-block h-4 w-1.5 animate-pulse bg-current align-middle"
        />
        <div
          v-if="message.role === 'assistant' && message.toolUse?.name"
          class="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"
        >
          <Wrench class="size-3" />
          <span>{{ message.toolUse.name }}</span>
        </div>
      </div>
    </div>

    <div
      v-if="message.role === 'user'"
      class="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
    >
      <User class="size-4" />
    </div>
  </div>
</template>
