import { defineStore } from "pinia";

export type ConversationMessage = Record<string, unknown>;

export type ActiveSession = {
  orgSlug: string;
  projSlug: string;
  draftId: string;
  title: string;
  baseVersion: number;
  status: "draft" | "published";
  files: Record<string, string>;
  conversation: ConversationMessage[];
  serverUpdatedAt: string;
};

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving"; attempt: number }
  | { kind: "retrying"; attempt: number; nextAttemptAt: number }
  | { kind: "failed"; reason: string };

type DraftEnvelope = {
  orgSlug: string;
  projSlug: string;
  draftId: string;
};

type DraftGetResponse = {
  id: string;
  title: string;
  baseVersion: number;
  status: "draft" | "published";
  files: Array<{ name: string; content: string }>;
  conversation: unknown[];
  updatedAt: string;
};

type PatchResponse = { updatedAt: string };

// 3 retries after the initial attempt: 2s / 4s / 8s. The plan sketches
// the literal union `1 | 2 | 3` for SaveState.attempt; we widen to
// `number` because the UI consumes it as "(N/3)" and 4 distinct attempt
// states would not fit. The retry budget is fixed at MAX_RETRIES.
const RETRY_BACKOFFS_MS = [2_000, 4_000, 8_000];
const MAX_RETRIES = RETRY_BACKOFFS_MS.length;

function draftUrl(s: { orgSlug: string; projSlug: string; draftId: string }): string {
  return `/api/orgs/${s.orgSlug}/projects/${s.projSlug}/spec-drafts/${s.draftId}`;
}

function filesArrayToRecord(files: Array<{ name: string; content: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) out[f.name] = f.content;
  return out;
}

function filesRecordToArray(files: Record<string, string>): Array<{ name: string; content: string }> {
  return Object.entries(files).map(([name, content]) => ({ name, content }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const useActiveSessionStore = defineStore("speckit-active-session", {
  state: () => ({
    session: null as ActiveSession | null,
    saveState: { kind: "idle" } as SaveState,
    pendingSave: false,
  }),

  actions: {
    async openDraft(env: DraftEnvelope): Promise<void> {
      const url = draftUrl(env);
      const res = await $fetch<DraftGetResponse>(url);
      this.session = {
        orgSlug: env.orgSlug,
        projSlug: env.projSlug,
        draftId: env.draftId,
        title: res.title,
        baseVersion: res.baseVersion,
        status: res.status,
        files: filesArrayToRecord(res.files),
        conversation: res.conversation as ConversationMessage[],
        serverUpdatedAt: res.updatedAt,
      };
      this.saveState = { kind: "idle" };
      this.pendingSave = false;
    },

    closeSession(): void {
      this.session = null;
      this.saveState = { kind: "idle" };
      this.pendingSave = false;
    },

    updateFiles(files: Record<string, string>): void {
      if (!this.session) return;
      this.session.files = { ...files };
      this.pendingSave = true;
    },

    appendTurn(turn: ConversationMessage): void {
      if (!this.session) return;
      this.session.conversation.push(turn);
      this.pendingSave = true;
    },

    /**
     * PATCH the active draft. On HTTP failure, retries up to MAX_RETRIES
     * times with exponential backoff. Final failure surfaces as
     * `saveState: failed` so the UI can render the "Save failed — Retry"
     * banner; `pendingSave` stays true until a successful PATCH lands so
     * we don't lose track of unsaved work.
     */
    async commitTurn(): Promise<void> {
      if (!this.session) return;
      const session = this.session;
      const url = draftUrl(session);
      const body = {
        files: filesRecordToArray(session.files),
        conversation: session.conversation,
      };

      for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
        if (attempt > 1) {
          const backoff = RETRY_BACKOFFS_MS[attempt - 2]!;
          this.saveState = {
            kind: "retrying",
            attempt: attempt - 1,
            nextAttemptAt: Date.now() + backoff,
          };
          await sleep(backoff);
        }
        this.saveState = { kind: "saving", attempt };

        try {
          const res = await $fetch<PatchResponse>(url, { method: "PATCH", body });
          if (this.session) this.session.serverUpdatedAt = res.updatedAt;
          this.pendingSave = false;
          this.saveState = { kind: "idle" };
          return;
        } catch (err) {
          if (attempt > MAX_RETRIES) {
            this.saveState = {
              kind: "failed",
              reason: err instanceof Error ? err.message : "save failed",
            };
            return;
          }
        }
      }
    },

    async retrySaveNow(): Promise<void> {
      this.saveState = { kind: "idle" };
      await this.commitTurn();
    },
  },

  persist: {
    // saveState is volatile — re-derived on tab reload. session +
    // pendingSave carry the work-in-progress that survives reloads.
    pick: ["session", "pendingSave"],
  },
});
