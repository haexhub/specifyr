import { computed, onMounted, ref, type Ref } from "vue";
import { streamText, type LanguageModel } from "ai";

import { SPECKIT_SYSTEM_PROMPT } from "~/lib/speckit-system-prompt";
import { buildLanguageModel } from "~/lib/speckit-model";
import { buildSpeckitTools } from "~/lib/speckit-tools";
import {
  useActiveSessionStore,
  type ConversationMessage,
  type SaveState,
  type ActiveSession,
} from "~/stores/active-session";
import { useProviderIdentityStore } from "~/stores/provider-identity";

export type SpeckitAgentArgs = {
  orgSlug: string;
  projSlug: string;
  draftId: string;
  /**
   * Test seam: inject a `LanguageModel` instead of building one from
   * the active provider identity. In production this is omitted and
   * the composable derives the model from the store.
   */
  modelOverride?: LanguageModel;
};

export type PublishResult =
  | { ok: true; newPublicVersion: number }
  | {
      conflict: true;
      currentPublicVersion: number;
      currentPublicFiles: Array<{ name: string; content: string }>;
    };

export type SpeckitAgent = {
  session: Ref<ActiveSession | null>;
  saveState: Ref<SaveState>;
  pendingSave: Ref<boolean>;
  isStreaming: Ref<boolean>;
  sendMessage: (text: string) => Promise<void>;
  cancel: () => void;
  publish: () => Promise<PublishResult>;
  retrySave: () => Promise<void>;
};

type PublishConflictBody = {
  conflict: true;
  currentPublicVersion: number;
  currentPublicFiles: Array<{ name: string; content: string }>;
};

function isPublishConflict(data: unknown): data is PublishConflictBody {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { conflict?: unknown }).conflict === true
  );
}

export function useSpeckitAgent(args: SpeckitAgentArgs): SpeckitAgent {
  const session = useActiveSessionStore();
  const identityStore = useProviderIdentityStore();
  const isStreaming = ref(false);
  let abortController: AbortController | null = null;

  onMounted(async () => {
    if (session.session?.draftId !== args.draftId) {
      await session.openDraft({
        orgSlug: args.orgSlug,
        projSlug: args.projSlug,
        draftId: args.draftId,
      });
    }
  });

  function resolveModel(): LanguageModel {
    if (args.modelOverride) return args.modelOverride;
    const id = identityStore.active;
    if (!id) {
      throw new Error(
        "No active provider identity. Configure one in Settings → Speckit agent.",
      );
    }
    return buildLanguageModel(id);
  }

  async function sendMessage(text: string): Promise<void> {
    if (isStreaming.value) return;
    if (!session.session) {
      throw new Error("Speckit session not loaded yet");
    }
    const userMessage: ConversationMessage = { role: "user", content: text };
    session.appendTurn(userMessage);

    isStreaming.value = true;
    abortController = new AbortController();
    try {
      const tools = buildSpeckitTools({
        orgSlug: args.orgSlug,
        projSlug: args.projSlug,
      });
      const result = streamText({
        model: resolveModel(),
        tools,
        system: SPECKIT_SYSTEM_PROMPT,
        // Vercel-AI-SDK accepts ModelMessage[] / UIMessage[]; our stored
        // shape is JSON-serialisable records that already conform.
        messages: session.session.conversation as never,
        abortSignal: abortController.signal,
      });

      const response = await result.response;
      for (const m of response.messages) {
        session.appendTurn(m as unknown as ConversationMessage);
      }

      await session.commitTurn();
    } catch (err) {
      // Don't swallow user-cancel — the AbortController path lands here
      // as a DOMException with name="AbortError". Other errors are
      // surfaced to the caller for the UI to display.
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        throw err;
      }
    } finally {
      isStreaming.value = false;
      abortController = null;
    }
  }

  function cancel(): void {
    abortController?.abort();
  }

  async function publish(): Promise<PublishResult> {
    if (!session.session) throw new Error("no active draft");
    if (session.pendingSave) {
      await session.commitTurn();
      if (session.pendingSave) {
        // commit failed — surface the failure to the UI via saveState;
        // don't proceed to publish with stale draft on disk.
        throw new Error(
          "Cannot publish: auto-save still pending. Resolve the failed save first.",
        );
      }
    }
    const url = `/api/orgs/${args.orgSlug}/projects/${args.projSlug}/spec-drafts/${args.draftId}/publish`;
    try {
      const res = await $fetch<{ ok: true; newPublicVersion: number }>(url, {
        method: "POST",
        body: {},
      });
      return { ok: true, newPublicVersion: res.newPublicVersion };
    } catch (err) {
      const status = (err as { statusCode?: number; status?: number }).statusCode
        ?? (err as { statusCode?: number; status?: number }).status;
      if (status === 409) {
        const data = (err as { data?: unknown }).data;
        if (isPublishConflict(data)) return data;
      }
      throw err;
    }
  }

  return {
    session: computed(() => session.session) as Ref<ActiveSession | null>,
    saveState: computed(() => session.saveState) as Ref<SaveState>,
    pendingSave: computed(() => session.pendingSave) as Ref<boolean>,
    isStreaming,
    sendMessage,
    cancel,
    publish,
    retrySave: () => session.retrySaveNow(),
  };
}
