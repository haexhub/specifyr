import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createPersistedState } from "pinia-plugin-persistedstate";

import { useActiveSessionStore } from "../../app/stores/active-session";

function freshPinia() {
  const app = createApp({ render: () => null });
  const pinia = createPinia();
  pinia.use(createPersistedState());
  app.use(pinia);
  setActivePinia(pinia);
  return pinia;
}

const ORG = "acme";
const PROJ = "demo";
const DRAFT_ID = "11111111-1111-1111-1111-111111111111";

function fakeDraftResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: DRAFT_ID,
    title: "Initial draft",
    baseVersion: 5,
    status: "draft" as const,
    files: [
      { name: "spec.md", content: "# Spec" },
      { name: "planning.md", content: "# Plan" },
    ],
    conversation: [{ role: "user", content: "hi" }],
    createdAt: "2026-05-19T10:00:00.000Z",
    updatedAt: "2026-05-19T10:00:00.000Z",
    publishedAt: null,
    ...overrides,
  };
}

describe("active-session store", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    freshPinia();
    fetchMock = vi.fn();
    vi.stubGlobal("$fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("openDraft", () => {
    it("fetches the draft and replaces session state", async () => {
      fetchMock.mockResolvedValueOnce(fakeDraftResponse());
      const store = useActiveSessionStore();

      await store.openDraft({ orgSlug: ORG, projSlug: PROJ, draftId: DRAFT_ID });

      expect(fetchMock).toHaveBeenCalledWith(
        `/api/orgs/${ORG}/projects/${PROJ}/spec-drafts/${DRAFT_ID}`,
      );
      expect(store.session).toMatchObject({
        orgSlug: ORG,
        projSlug: PROJ,
        draftId: DRAFT_ID,
        title: "Initial draft",
        baseVersion: 5,
        status: "draft",
      });
      expect(store.session?.files).toEqual({
        "spec.md": "# Spec",
        "planning.md": "# Plan",
      });
      expect(store.session?.conversation).toEqual([{ role: "user", content: "hi" }]);
      expect(store.pendingSave).toBe(false);
      expect(store.saveState).toEqual({ kind: "idle" });
    });

    it("clears any previous failed-save banner when opening a new draft", async () => {
      fetchMock.mockResolvedValueOnce(fakeDraftResponse());
      const store = useActiveSessionStore();
      store.saveState = { kind: "failed", reason: "old failure" };

      await store.openDraft({ orgSlug: ORG, projSlug: PROJ, draftId: DRAFT_ID });

      expect(store.saveState).toEqual({ kind: "idle" });
    });
  });

  describe("mutations mark pendingSave", () => {
    beforeEach(async () => {
      fetchMock.mockResolvedValueOnce(fakeDraftResponse());
      const store = useActiveSessionStore();
      await store.openDraft({ orgSlug: ORG, projSlug: PROJ, draftId: DRAFT_ID });
    });

    it("updateFiles replaces the file map and flips pendingSave", () => {
      const store = useActiveSessionStore();
      store.updateFiles({ "spec.md": "# Updated" });
      expect(store.session?.files).toEqual({ "spec.md": "# Updated" });
      expect(store.pendingSave).toBe(true);
    });

    it("appendTurn pushes onto conversation and flips pendingSave", () => {
      const store = useActiveSessionStore();
      store.appendTurn({ role: "assistant", content: "hello" });
      expect(store.session?.conversation).toEqual([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ]);
      expect(store.pendingSave).toBe(true);
    });

    it("mutations are no-ops without an open session", () => {
      const store = useActiveSessionStore();
      store.closeSession();
      store.updateFiles({ "x.md": "y" });
      store.appendTurn({ role: "user", content: "x" });
      expect(store.session).toBeNull();
      expect(store.pendingSave).toBe(false);
    });
  });

  describe("commitTurn", () => {
    beforeEach(async () => {
      fetchMock.mockResolvedValueOnce(fakeDraftResponse());
      const store = useActiveSessionStore();
      await store.openDraft({ orgSlug: ORG, projSlug: PROJ, draftId: DRAFT_ID });
      store.updateFiles({ "spec.md": "# Edited" });
    });

    it("PATCHes once and clears pendingSave on success", async () => {
      fetchMock.mockResolvedValueOnce({ updatedAt: "2026-05-19T11:00:00.000Z" });
      const store = useActiveSessionStore();

      await store.commitTurn();

      expect(fetchMock).toHaveBeenCalledWith(
        `/api/orgs/${ORG}/projects/${PROJ}/spec-drafts/${DRAFT_ID}`,
        expect.objectContaining({
          method: "PATCH",
          body: {
            files: [{ name: "spec.md", content: "# Edited" }],
            conversation: [{ role: "user", content: "hi" }],
          },
        }),
      );
      expect(store.pendingSave).toBe(false);
      expect(store.saveState).toEqual({ kind: "idle" });
      expect(store.session?.serverUpdatedAt).toBe("2026-05-19T11:00:00.000Z");
    });

    it("retries up to 3 times with exponential backoff before giving up", async () => {
      vi.useFakeTimers();
      fetchMock.mockRejectedValue(new Error("network down"));
      const store = useActiveSessionStore();

      const promise = store.commitTurn();
      // initial attempt
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2); // GET (openDraft) + 1st PATCH

      // attempt 2 fires after 2s
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      // attempt 3 fires after 4s more
      await vi.advanceTimersByTimeAsync(4_000);
      expect(fetchMock).toHaveBeenCalledTimes(4);

      // final retry after 8s — store gives up after this
      await vi.advanceTimersByTimeAsync(8_000);
      await promise;

      expect(fetchMock).toHaveBeenCalledTimes(5); // GET + 4 PATCHes (1 + 3 retries)
      expect(store.pendingSave).toBe(true);
      expect(store.saveState).toMatchObject({ kind: "failed" });
    });

    it("succeeds on a later retry and lands in idle", async () => {
      vi.useFakeTimers();
      fetchMock
        .mockRejectedValueOnce(new Error("flaky 1"))
        .mockRejectedValueOnce(new Error("flaky 2"))
        .mockResolvedValueOnce({ updatedAt: "2026-05-19T11:00:00.000Z" });
      const store = useActiveSessionStore();

      const promise = store.commitTurn();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(4_000);
      await promise;

      expect(store.pendingSave).toBe(false);
      expect(store.saveState).toEqual({ kind: "idle" });
    });

    it("fails immediately on non-retryable 4xx without burning retry budget", async () => {
      vi.useFakeTimers();
      fetchMock.mockRejectedValue(
        Object.assign(new Error("forbidden"), { statusCode: 403 }),
      );
      const store = useActiveSessionStore();

      const promise = store.commitTurn();
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      // GET (openDraft) + 1 PATCH only — no retries on 403.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(store.saveState).toMatchObject({ kind: "failed" });
      expect(store.pendingSave).toBe(true);
    });

    it("retries on 503 (transient 5xx)", async () => {
      vi.useFakeTimers();
      fetchMock
        .mockRejectedValueOnce(
          Object.assign(new Error("unavailable"), { statusCode: 503 }),
        )
        .mockResolvedValueOnce({ updatedAt: "2026-05-19T11:00:00.000Z" });
      const store = useActiveSessionStore();

      const promise = store.commitTurn();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
      await promise;

      expect(store.saveState).toEqual({ kind: "idle" });
      expect(store.pendingSave).toBe(false);
    });

    it("keeps pendingSave true if new edits land during in-flight PATCH", async () => {
      // Drive the PATCH to a manually controlled resolver so we can land
      // an extra edit between request-out and response-in.
      let resolvePatch!: (v: { updatedAt: string }) => void;
      fetchMock.mockReturnValueOnce(
        new Promise<{ updatedAt: string }>((r) => {
          resolvePatch = r;
        }),
      );
      const store = useActiveSessionStore();

      const commit = store.commitTurn();
      // While the PATCH is in flight, a tool call writes new files.
      store.updateFiles({ "spec.md": "# After-the-PATCH" });
      resolvePatch({ updatedAt: "2026-05-19T12:00:00.000Z" });
      await commit;

      // PATCH itself succeeded → no failed banner.
      expect(store.saveState).toEqual({ kind: "idle" });
      // …but the in-flight payload didn't include the new edits, so
      // pendingSave must stay true to drive the next commitTurn.
      expect(store.pendingSave).toBe(true);
    });
  });

  describe("retrySaveNow", () => {
    it("clears the failed banner and PATCHes again", async () => {
      fetchMock.mockResolvedValueOnce(fakeDraftResponse());
      const store = useActiveSessionStore();
      await store.openDraft({ orgSlug: ORG, projSlug: PROJ, draftId: DRAFT_ID });
      store.updateFiles({ "spec.md": "# Edited" });
      store.saveState = { kind: "failed", reason: "previous failure" };

      fetchMock.mockResolvedValueOnce({ updatedAt: "2026-05-19T12:00:00.000Z" });
      await store.retrySaveNow();

      expect(store.saveState).toEqual({ kind: "idle" });
      expect(store.pendingSave).toBe(false);
    });
  });

  describe("persistence", () => {
    it("rehydrates session + pendingSave but resets saveState to idle", async () => {
      fetchMock.mockResolvedValueOnce(fakeDraftResponse());
      const store1 = useActiveSessionStore();
      await store1.openDraft({ orgSlug: ORG, projSlug: PROJ, draftId: DRAFT_ID });
      store1.updateFiles({ "spec.md": "# half-saved" });
      store1.saveState = { kind: "failed", reason: "should not survive" };
      await nextTick();

      setActivePinia(undefined as never);
      freshPinia();

      const store2 = useActiveSessionStore();
      expect(store2.session?.draftId).toBe(DRAFT_ID);
      expect(store2.session?.files).toEqual({ "spec.md": "# half-saved" });
      expect(store2.pendingSave).toBe(true);
      expect(store2.saveState).toEqual({ kind: "idle" });
    });
  });
});
