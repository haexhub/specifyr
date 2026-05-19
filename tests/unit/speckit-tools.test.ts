import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createPersistedState } from "pinia-plugin-persistedstate";

import { buildSpeckitTools } from "../../app/lib/speckit-tools";
import { useActiveSessionStore } from "../../app/stores/active-session";

function freshPinia() {
  const app = createApp({ render: () => null });
  const pinia = createPinia();
  pinia.use(createPersistedState());
  app.use(pinia);
  setActivePinia(pinia);
  return pinia;
}

const CTX = { orgSlug: "acme", projSlug: "demo" };
const BASE = `/api/orgs/${CTX.orgSlug}/projects/${CTX.projSlug}`;

// Minimal ToolExecutionOptions stub — real options are passed by the
// AI SDK at runtime; our execute() implementations don't read them.
const OPTS = {
  toolCallId: "test-call",
  messages: [],
  abortSignal: undefined,
} as unknown as Parameters<NonNullable<ReturnType<typeof buildSpeckitTools>["list_files"]["execute"]>>[1];

describe("buildSpeckitTools", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    freshPinia();
    fetchMock = vi.fn();
    vi.stubGlobal("$fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("list_files", () => {
    it("GETs /files without query when glob is omitted", async () => {
      fetchMock.mockResolvedValueOnce({ files: [], truncated: false });
      const tools = buildSpeckitTools(CTX);
      await tools.list_files.execute!({}, OPTS);
      expect(fetchMock).toHaveBeenCalledWith(`${BASE}/files`, {
        query: undefined,
      });
    });

    it("forwards glob as a query param", async () => {
      fetchMock.mockResolvedValueOnce({ files: [], truncated: false });
      const tools = buildSpeckitTools(CTX);
      await tools.list_files.execute!({ glob: "**/*.md" }, OPTS);
      expect(fetchMock).toHaveBeenCalledWith(`${BASE}/files`, {
        query: { glob: "**/*.md" },
      });
    });
  });

  describe("read_file", () => {
    it("URL-encodes each path segment but preserves the slash structure", async () => {
      fetchMock.mockResolvedValueOnce({ content: "x", encoding: "utf-8" });
      const tools = buildSpeckitTools(CTX);
      await tools.read_file.execute!(
        { path: "docs/a b/notes#1.md" },
        OPTS,
      );
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE}/files/docs/a%20b/notes%231.md`,
      );
    });
  });

  describe("search_code", () => {
    it("POSTs the validated input as the body", async () => {
      fetchMock.mockResolvedValueOnce({ matches: [], truncated: false });
      const tools = buildSpeckitTools(CTX);
      await tools.search_code.execute!(
        { query: "TODO", glob: "**/*.ts", limit: 50 },
        OPTS,
      );
      expect(fetchMock).toHaveBeenCalledWith(`${BASE}/search`, {
        method: "POST",
        body: { query: "TODO", glob: "**/*.ts", limit: 50 },
      });
    });
  });

  describe("read_existing_spec", () => {
    it("GETs without query when name is omitted", async () => {
      fetchMock.mockResolvedValueOnce({ version: 3, files: [] });
      const tools = buildSpeckitTools(CTX);
      await tools.read_existing_spec.execute!({}, OPTS);
      expect(fetchMock).toHaveBeenCalledWith(`${BASE}/spec-public-state`, {
        query: undefined,
      });
    });

    it("forwards name as a query param when provided", async () => {
      fetchMock.mockResolvedValueOnce({ version: 3, files: [] });
      const tools = buildSpeckitTools(CTX);
      await tools.read_existing_spec.execute!({ name: "spec.md" }, OPTS);
      expect(fetchMock).toHaveBeenCalledWith(`${BASE}/spec-public-state`, {
        query: { name: "spec.md" },
      });
    });
  });

  describe("list_my_drafts", () => {
    it("GETs /spec-drafts/mine with no body", async () => {
      fetchMock.mockResolvedValueOnce({ drafts: [] });
      const tools = buildSpeckitTools(CTX);
      await tools.list_my_drafts.execute!({}, OPTS);
      expect(fetchMock).toHaveBeenCalledWith(`${BASE}/spec-drafts/mine`);
    });
  });

  describe("load_draft", () => {
    it("GETs /spec-drafts/{draftId}", async () => {
      const draftId = "11111111-1111-1111-1111-111111111111";
      fetchMock.mockResolvedValueOnce({ id: draftId });
      const tools = buildSpeckitTools(CTX);
      await tools.load_draft.execute!({ draftId }, OPTS);
      expect(fetchMock).toHaveBeenCalledWith(`${BASE}/spec-drafts/${draftId}`);
    });
  });

  describe("update_draft_files", () => {
    it("writes to the active-session store and never calls $fetch", async () => {
      // Seed an active session so updateFiles has somewhere to write.
      fetchMock.mockResolvedValueOnce({
        id: "draft-1",
        title: "t",
        baseVersion: 0,
        status: "draft",
        files: [{ name: "old.md", content: "old" }],
        conversation: [],
        createdAt: "2026-05-19T10:00:00Z",
        updatedAt: "2026-05-19T10:00:00Z",
        publishedAt: null,
      });
      const session = useActiveSessionStore();
      await session.openDraft({ ...CTX, draftId: "draft-1" });
      fetchMock.mockClear();

      const tools = buildSpeckitTools(CTX);
      const result = await tools.update_draft_files.execute!(
        {
          files: [
            { name: "spec.md", content: "# new" },
            { name: "planning.md", content: "# plan" },
          ],
        },
        OPTS,
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true, files: ["spec.md", "planning.md"] });
      expect(session.session?.files).toEqual({
        "old.md": "old",
        "spec.md": "# new",
        "planning.md": "# plan",
      });
      expect(session.pendingSave).toBe(true);
    });
  });
});
