<script setup lang="ts">
import { User, Bot, TriangleAlert, Wrench } from "lucide-vue-next";
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";
import type { ChatMessage } from "~/lib/types";

const props = defineProps<{
  message: ChatMessage;
  streaming?: boolean;
}>();

const renderedContent = computed(() => {
  if (props.message.role !== "assistant") return null;
  const html = marked.parse(props.message.content ?? "", { async: false }) as string;
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

    <div
      class="max-w-[80%] rounded-lg px-4 py-2.5 text-sm leading-6"
      :class="[
        message.role === 'user' && 'bg-primary text-primary-foreground',
        message.role === 'assistant' && 'border border-border bg-card',
        message.role === 'system' && 'border border-destructive/30 bg-destructive/5 text-destructive',
        message.role === 'tool' && 'border border-border bg-muted/60 font-mono text-xs'
      ]"
    >
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-if="renderedContent" class="chat-prose" v-html="renderedContent" />
      <pre v-else class="whitespace-pre-wrap wrap-break-word font-sans">{{ message.content }}</pre>
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

    <div
      v-if="message.role === 'user'"
      class="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
    >
      <User class="size-4" />
    </div>
  </div>
</template>
