/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createPersistedState } from "pinia-plugin-persistedstate";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModel } from "ai";

import { useSpeckitAgent } from "../../app/composables/useSpeckitAgent";
import { useActiveSessionStore } from "../../app/stores/active-session";

const CTX = {
  orgSlug: "acme",
  projSlug: "demo",
  draftId: "11111111-1111-1111-1111-111111111111",
};
const BASE = `/api/orgs/${CTX.orgSlug}/projects/${CTX.projSlug}`;

function freshPinia() {
  const app = createApp({ render: () => null });
  const pinia = createPinia();
  pinia.use(createPersistedState());
  app.use(pinia);
  setActivePinia(pinia);
  return { app, pinia };
}

/**
 * Mount the composable inside a Vue component so onMounted runs. The
 * onMounted hook in useSpeckitAgent kicks off the initial openDraft;
 * without a mounted host the lifecycle hook never fires.
 */
function mountAgent(modelOverride?: LanguageModel) {
  const { app, pinia } = freshPinia();
  let agent: ReturnType<typeof useSpeckitAgent> | null = null;
  const Host = defineComponent({
    setup() {
      agent = useSpeckitAgent({ ...CTX, modelOverride });
      return () => h("div");
    },
  });
  app.use(pinia);
  const root = document.createElement("div");
  app.mount(root);
  app.component("Host", Host);
  // Mount Host into a second app so its setup runs synchronously.
  const hostApp = createApp(Host);
  hostApp.use(pinia);
  const hostEl = document.createElement("div");
  hostApp.mount(hostEl);
  return { agent: agent!, teardown: () => hostApp.unmount() };
}

function fakeDraftResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: CTX.draftId,
    title: "draft",
    baseVersion: 0,
    status: "draft",
    files: [{ name: "spec.md", content: "" }],
    conversation: [],
    createdAt: "2026-05-19T10:00:00Z",
    updatedAt: "2026-05-19T10:00:00Z",
    publishedAt: null,
    ...overrides,
  };
}

describe("useSpeckitAgent", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal("$fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("publish", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(fakeDraftResponse());
    });

    it("POSTs publish on the org-scoped route and returns ok+version on success", async () => {
      const { agent, teardown } = mountAgent();
      await nextTick();
      await nextTick(); // let onMounted's openDraft resolve

      fetchMock.mockResolvedValueOnce({ ok: true, newPublicVersion: 1 });
      const res = await agent.publish();

      expect(fetchMock).toHaveBeenLastCalledWith(
        `${BASE}/spec-drafts/${CTX.draftId}/publish`,
        { method: "POST", body: {} },
      );
      expect(res).toEqual({ ok: true, newPublicVersion: 1 });
      teardown();
    });

    it("maps a 409 into a conflict result instead of throwing", async () => {
      const { agent, teardown } = mountAgent();
      await nextTick();
      await nextTick();

      const conflict = {
        conflict: true as const,
        currentPublicVersion: 7,
        currentPublicFiles: [{ name: "spec.md", content: "newer" }],
      };
      // The Nuxt $fetch shape for failures is FetchError({ statusCode, data }).
      fetchMock.mockRejectedValueOnce({ statusCode: 409, data: conflict });
      const res = await agent.publish();
      expect(res).toEqual(conflict);
      teardown();
    });

    it("commits any pending save before publishing", async () => {
      const { agent, teardown } = mountAgent();
      await nextTick();
      await nextTick();

      const session = useActiveSessionStore();
      session.updateFiles({ "spec.md": "# edited" });
      expect(session.pendingSave).toBe(true);

      // 1st post-mount call: PATCH (commit)
      fetchMock.mockResolvedValueOnce({ updatedAt: "2026-05-19T11:00:00Z" });
      // 2nd: publish
      fetchMock.mockResolvedValueOnce({ ok: true, newPublicVersion: 1 });

      const res = await agent.publish();

      const calls = fetchMock.mock.calls;
      const patch = calls.find(
        (c) =>
          c[0] === `${BASE}/spec-drafts/${CTX.draftId}` &&
          (c[1] as { method?: string })?.method === "PATCH",
      );
      const publish = calls.find(
        (c) => c[0] === `${BASE}/spec-drafts/${CTX.draftId}/publish`,
      );
      expect(patch).toBeTruthy();
      expect(publish).toBeTruthy();
      // patch must come before publish
      expect(calls.indexOf(patch!)).toBeLessThan(calls.indexOf(publish!));
      expect(res).toEqual({ ok: true, newPublicVersion: 1 });
      expect(session.pendingSave).toBe(false);
      teardown();
    });
  });

  describe("retrySave", () => {
    it("proxies to the session store's retrySaveNow", async () => {
      fetchMock.mockResolvedValueOnce(fakeDraftResponse());
      const { agent, teardown } = mountAgent();
      await nextTick();
      await nextTick();

      const session = useActiveSessionStore();
      session.updateFiles({ "spec.md": "x" });
      session.saveState = { kind: "failed", reason: "earlier" };

      fetchMock.mockResolvedValueOnce({ updatedAt: "2026-05-19T11:00:00Z" });
      await agent.retrySave();

      expect(session.saveState).toEqual({ kind: "idle" });
      expect(session.pendingSave).toBe(false);
      teardown();
    });
  });

  describe("sendMessage", () => {
    it("streams a text response, appends it to conversation, and commits", async () => {
      fetchMock.mockResolvedValueOnce(fakeDraftResponse());

      const model = new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "r1", modelId: "mock", timestamp: new Date() },
              { type: "text-start", id: "t0" },
              { type: "text-delta", id: "t0", delta: "Hello " },
              { type: "text-delta", id: "t0", delta: "world" },
              { type: "text-end", id: "t0" },
              {
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
              },
            ],
          }),
        }),
      });

      const { agent, teardown } = mountAgent(model as unknown as LanguageModel);
      await nextTick();
      await nextTick();

      // Commit PATCH after the turn finishes.
      fetchMock.mockResolvedValueOnce({ updatedAt: "2026-05-19T11:00:00Z" });

      await agent.sendMessage("hi");

      const session = useActiveSessionStore();
      const roles = session.session?.conversation.map((m) => (m as { role?: string }).role) ?? [];
      expect(roles[0]).toBe("user");
      expect(roles).toContain("assistant");
      expect(session.pendingSave).toBe(false);
      expect(session.saveState).toEqual({ kind: "idle" });
      expect(agent.isStreaming.value).toBe(false);
      teardown();
    });
  });
});
