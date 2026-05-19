<script setup lang="ts">
import ChatPanel from "~/components/speckit/ChatPanel.vue";
import { useSpeckitAgent } from "~/composables/useSpeckitAgent";

const props = defineProps<{
  orgSlug: string;
  projSlug: string;
  draftId: string;
}>();

const emit = defineEmits<{
  publish: [];
  /**
   * The composable owns its own onMounted; this event lets the parent
   * know a publish-success has happened so it can refresh the draft list.
   */
  publishSuccess: [];
}>();

const agent = useSpeckitAgent({
  orgSlug: props.orgSlug,
  projSlug: props.projSlug,
  draftId: props.draftId,
});

defineExpose({
  publish: () => agent.publish(),
  agent,
});

function onPublishClick() {
  emit("publish");
}
</script>

<template>
  <ChatPanel
    :session="agent.session.value"
    :is-streaming="agent.isStreaming.value"
    :save-state="agent.saveState.value"
    :pending-save="agent.pendingSave.value"
    @send="(t) => agent.sendMessage(t)"
    @cancel="() => agent.cancel()"
    @publish="onPublishClick"
    @retry-save="() => agent.retrySave()"
  />
</template>
